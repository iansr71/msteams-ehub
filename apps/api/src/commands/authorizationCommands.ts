import {
  EXIT_FAILURE,
  EXIT_OK,
  loadConfig,
  parseCommandArgs,
  defineConfigSchema,
  runtimeConfigSchema,
  syncConfigShape,
  type CommandContext,
  type CommandDefinition,
  type EnvironmentSource,
} from '@ehub/shared';
import { z } from 'zod';

import { AuthorizationUnavailableError } from '../authorization/errors.js';
import {
  createAuthorizationServices,
  type AuthorizationDependencies,
  type AuthorizationServices,
} from '../authorization/factory.js';
import type { EntraIdentityClaims } from '../authorization/moodleIdentityResolver.js';
import { actorSchema, observedClaims, type EntraUserKey } from '../authorization/records.js';
import { describeFailure, withErrorHandling, type FailureReport } from './retrievalCommands.js';

/*
 * Administrator commands (`pnpm identity …`, `pnpm authorization …`). Output is JSON with IDs,
 * reason codes and course IDs only: no names, and email or UPN only as a masked hint (first
 * character and domain) so an operator can tell which claim was used.
 */

export type AuthorizationCommandDependencies = AuthorizationDependencies & {
  readonly now?: () => Date;
};

const guid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, {
    message: 'must be a GUID.',
  })
  .transform((value) => value.toLowerCase());
const emailArg = z.email({ message: 'must be an email address.' }).max(256).optional();
const upnArg = z
  .string()
  .regex(/^[^\s@]{1,128}@[^\s@]{1,128}$/, { message: 'must be a UPN.' })
  .optional();
const userArgs = {
  'entra-object-id': guid,
  'tenant-id': guid.optional(),
  email: emailArg,
  upn: upnArg,
  json: z.boolean().optional(),
};
const USER_FLAGS = {
  'entra-object-id': 'string',
  'tenant-id': 'string',
  email: 'string',
  upn: 'string',
  json: 'boolean',
} as const;

/** `t…@skinrenewal.co.za`: enough to recognise the claim, not enough to read it. */
export function maskAddress(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const at = value.lastIndexOf('@');
  if (at <= 0) {
    return '…';
  }
  return `${value.slice(0, 1)}…@${value.slice(at + 1).replace(/#ext#/gi, '')}`;
}

function describeAuthorizationFailure(error: unknown): FailureReport | undefined {
  if (error instanceof AuthorizationUnavailableError) {
    return {
      status: 'error',
      error: { category: error.reason, message: error.message },
    };
  }
  return describeFailure(error);
}

const tenantConfigSchema = defineConfigSchema({ AZURE_TENANT_ID: syncConfigShape.AZURE_TENANT_ID });

function tenantOf(env: EnvironmentSource, explicit: string | undefined): string {
  return explicit ?? loadConfig(tenantConfigSchema, env).AZURE_TENANT_ID.toLowerCase();
}

/**
 * The claims to evaluate: explicit flags win (for checking a user before they sign in);
 * otherwise those recorded when the user last signed in.
 */
async function claimsFor(
  services: AuthorizationServices,
  key: EntraUserKey,
  args: { readonly email?: string | undefined; readonly upn?: string | undefined },
): Promise<{
  readonly claims: EntraIdentityClaims;
  readonly source: 'arguments' | 'last-sign-in' | 'none';
}> {
  if (args.email !== undefined || args.upn !== undefined) {
    return {
      source: 'arguments',
      claims: {
        ...key,
        ...(args.email === undefined
          ? {}
          : { email: args.email.toLowerCase(), emailAsIssued: args.email }),
        ...(args.upn === undefined
          ? {}
          : { userPrincipalName: args.upn, userPrincipalNameSource: 'upn' as const }),
      },
    };
  }
  const observation = await services.repository.getObservation(key);
  return observation === undefined
    ? { source: 'none', claims: key }
    : { source: 'last-sign-in', claims: observedClaims(observation) };
}

function claimSummary(claims: EntraIdentityClaims, source: string): Record<string, unknown> {
  return {
    source,
    ...(claims.email === undefined ? {} : { email: maskAddress(claims.email) }),
    ...(claims.userPrincipalName === undefined
      ? {}
      : { userPrincipalName: maskAddress(claims.userPrincipalName) }),
    ...(claims.accountType === undefined ? {} : { accountType: claims.accountType }),
  };
}

function command(
  dependencies: AuthorizationCommandDependencies,
  description: string,
  action: string,
  body: (context: CommandContext, services: () => AuthorizationServices) => Promise<number>,
): CommandDefinition {
  return {
    description,
    run: (context) =>
      withErrorHandling(
        context,
        action,
        async () => {
          loadConfig(runtimeConfigSchema, dependencies.env);
          let services: AuthorizationServices | undefined;
          return await body(context, () => {
            services ??= createAuthorizationServices(dependencies, context.logger);
            return services;
          });
        },
        describeAuthorizationFailure,
      ),
  };
}

function print(context: CommandContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2));
}

export function createIdentityCommands(
  dependencies: AuthorizationCommandDependencies,
): Readonly<Record<string, CommandDefinition>> {
  const now = dependencies.now ?? (() => new Date());
  return {
    resolve: command(
      dependencies,
      'Show which Moodle account an Entra user maps to (dry run: nothing is recorded).',
      'Identity resolution',
      async (context, services) => {
        const args = parseCommandArgs(context.args, USER_FLAGS, z.object(userArgs).strict());
        const key = {
          tenantId: tenantOf(dependencies.env, args['tenant-id']),
          objectId: args['entra-object-id'],
        };
        const { claims, source } = await claimsFor(services(), key, args);
        const resolution = await services().resolver.resolve(claims, { audit: false });
        print(context, {
          status: 'ok',
          entraObjectId: key.objectId,
          tenantId: key.tenantId,
          claimsUsed: claimSummary(claims, source),
          result: resolution,
        });
        return EXIT_OK;
      },
    ),
    map: command(
      dependencies,
      'Approve an explicit mapping from an Entra user to a Moodle account.',
      'Identity mapping',
      async (context, services) => {
        const args = parseCommandArgs(
          context.args,
          {
            'entra-object-id': 'string',
            'tenant-id': 'string',
            'moodle-user-id': 'string',
            'approved-by': 'string',
            reference: 'string',
            json: 'boolean',
          },
          z
            .object({
              'entra-object-id': guid,
              'tenant-id': guid.optional(),
              'moodle-user-id': z
                .string()
                .regex(/^[1-9]\d{0,9}$/, { message: 'must be a positive whole number.' })
                .transform(Number),
              'approved-by': actorSchema,
              reference: z
                .string()
                .regex(/^[A-Za-z0-9][A-Za-z0-9 ._#:/-]{0,99}$/, {
                  message: 'must be a short reference such as a ticket number.',
                })
                .optional(),
              json: z.boolean().optional(),
            })
            .strict(),
        );
        const key = {
          tenantId: tenantOf(dependencies.env, args['tenant-id']),
          objectId: args['entra-object-id'],
        };
        const mapping = {
          ...key,
          moodleUserId: args['moodle-user-id'],
          approvedBy: args['approved-by'],
          approvedAt: now().toISOString(),
          ...(args.reference === undefined ? {} : { reference: args.reference }),
        };
        // Checked with Moodle before saving: a mapping to a missing or suspended account would
        // only ever deny, and is almost certainly a typo.
        const { repository, resolver } = services();
        const check = await resolver.checkAccount(mapping.moodleUserId);
        if (check.status !== 'mapped') {
          print(context, {
            status: 'refused',
            reason: check.reason,
            moodleUserId: mapping.moodleUserId,
          });
          return EXIT_FAILURE;
        }
        const previous = await repository.getMapping(key);
        await repository.saveMapping(mapping);
        await repository.addInvalidation({
          scope: key,
          at: now().toISOString(),
          reason: 'mapping_changed',
        });
        print(context, {
          status: 'mapped',
          entraObjectId: key.objectId,
          moodleUserId: mapping.moodleUserId,
          replaced: previous?.moodleUserId ?? null,
        });
        return EXIT_OK;
      },
    ),
    unmap: command(
      dependencies,
      'Remove an explicit mapping (the user falls back to automatic matching).',
      'Identity unmapping',
      async (context, services) => {
        const args = parseCommandArgs(
          context.args,
          { 'entra-object-id': 'string', 'tenant-id': 'string', json: 'boolean' },
          z
            .object({
              'entra-object-id': guid,
              'tenant-id': guid.optional(),
              json: z.boolean().optional(),
            })
            .strict(),
        );
        const key = {
          tenantId: tenantOf(dependencies.env, args['tenant-id']),
          objectId: args['entra-object-id'],
        };
        const removed = await services().repository.deleteMapping(key);
        if (removed) {
          await services().repository.addInvalidation({
            scope: key,
            at: now().toISOString(),
            reason: 'mapping_changed',
          });
        }
        print(context, { status: removed ? 'removed' : 'not_found', entraObjectId: key.objectId });
        return removed ? EXIT_OK : EXIT_FAILURE;
      },
    ),
    failures: command(
      dependencies,
      'List denied mappings (audit trail), newest first.',
      'Identity audit',
      async (context, services) => {
        const args = parseCommandArgs(
          context.args,
          { 'entra-object-id': 'string', 'tenant-id': 'string', limit: 'string', json: 'boolean' },
          z
            .object({
              'entra-object-id': guid.optional(),
              'tenant-id': guid.optional(),
              limit: z
                .string()
                .regex(/^\d{1,4}$/, { message: 'must be a whole number up to 2000.' })
                .transform(Number)
                .pipe(z.number().min(1).max(2_000))
                .optional(),
              json: z.boolean().optional(),
            })
            .strict(),
        );
        const key =
          args['entra-object-id'] === undefined
            ? undefined
            : {
                tenantId: tenantOf(dependencies.env, args['tenant-id']),
                objectId: args['entra-object-id'],
              };
        const failures = await services().repository.listFailures({
          limit: args.limit ?? 50,
          ...(key === undefined ? {} : { key }),
        });
        print(context, { status: 'ok', count: failures.length, failures });
        return EXIT_OK;
      },
    ),
  };
}

export function createAuthorizationCommands(
  dependencies: AuthorizationCommandDependencies,
): Readonly<Record<string, CommandDefinition>> {
  const now = dependencies.now ?? (() => new Date());
  return {
    courses: command(
      dependencies,
      'Show the courses an Entra user may ask about, straight from Moodle (cache bypassed).',
      'Course authorisation',
      async (context, services) => {
        const args = parseCommandArgs(context.args, USER_FLAGS, z.object(userArgs).strict());
        const key = {
          tenantId: tenantOf(dependencies.env, args['tenant-id']),
          objectId: args['entra-object-id'],
        };
        const { claims, source } = await claimsFor(services(), key, args);
        const current = await services().courses.current(claims);
        print(context, {
          status: 'ok',
          entraObjectId: key.objectId,
          claimsUsed: claimSummary(claims, source),
          ...(current.kind === 'authorized'
            ? {
                result: 'authorized',
                method: current.method,
                moodleUserId: current.moodleUserId,
                courseCount: current.courseIds.length,
                courseIds: current.courseIds,
              }
            : { result: 'denied', reason: current.reason, courseIds: [] }),
        });
        return EXIT_OK;
      },
    ),
    invalidate: command(
      dependencies,
      'Make the API re-check one user (or everyone) with Moodle on their next question.',
      'Cache invalidation',
      async (context, services) => {
        const args = parseCommandArgs(
          context.args,
          { 'entra-object-id': 'string', 'tenant-id': 'string', all: 'boolean', json: 'boolean' },
          z
            .object({
              'entra-object-id': guid.optional(),
              'tenant-id': guid.optional(),
              all: z.boolean().optional(),
              json: z.boolean().optional(),
            })
            .strict()
            .refine((value) => (value.all === true) !== (value['entra-object-id'] !== undefined), {
              message: 'give --entra-object-id or --all.',
              path: ['entra-object-id'],
            }),
        );
        const scope =
          args.all === true
            ? ('all' as const)
            : {
                tenantId: tenantOf(dependencies.env, args['tenant-id']),
                objectId: args['entra-object-id'] ?? '',
              };
        await services().repository.addInvalidation({
          scope,
          at: now().toISOString(),
          reason: 'admin',
        });
        print(context, {
          status: 'invalidated',
          scope: scope === 'all' ? 'all' : scope.objectId,
          appliesWithinSeconds: services().config.AUTHZ_INVALIDATION_POLL_SECONDS,
        });
        return EXIT_OK;
      },
    ),
    sync: command(
      dependencies,
      'Re-check every known user with Moodle and revoke cached access that changed.',
      'Enrolment sync',
      async (context, services) => {
        parseCommandArgs(
          context.args,
          { json: 'boolean' },
          z.object({ json: z.boolean().optional() }).strict(),
        );
        const result = await services().syncJob.run();
        print(context, { status: result.errors > 0 ? 'partial' : 'ok', ...result });
        return result.errors > 0 ? EXIT_FAILURE : EXIT_OK;
      },
    ),
  };
}
