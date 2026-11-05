import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { Logger } from '@ehub/shared';
import { z } from 'zod';

import type { AuthenticatedCaller, RequestAuthenticator } from '../http/authentication.js';
import type { IdentityMappingRepository } from '../authorization/identityMappingRepository.js';
import type { MoodleIdentityResolver } from '../authorization/moodleIdentityResolver.js';
import type { EntraUserKey } from '../authorization/records.js';
import { AuthorizationUnavailableError } from '../authorization/errors.js';
import type { AdminDataService } from './adminData.js';
import type { ConfigurationSection } from './configurationSnapshot.js';
import type { AdminAction, AuditEvent } from './events.js';
import type { EventStore } from './eventStore.js';
import { JobRunnerBusyError, type AdminJobRunner } from './jobRunner.js';
import { adminRolesOf, permissionsOf, type Permission } from './roles.js';

export const ADMIN_PATH = '/admin';
const API_PREFIX = '/admin/api/';
const MAX_BODY_BYTES = 16 * 1024;

/** What the page needs to sign in. Public: it holds IDs, never secrets. */
export type AdminClientConfig =
  | {
      readonly mode: 'msal';
      readonly clientId: string;
      readonly authority: string;
      readonly scopes: readonly string[];
    }
  | { readonly mode: 'dev-mock'; readonly mockUserId: string }
  | { readonly mode: 'unavailable' };

export interface AdminIdentityControls {
  readonly repository: IdentityMappingRepository;
  readonly resolver: Pick<MoodleIdentityResolver, 'checkAccount'>;
  /** Drops this process's cached authorisation: one user, or everyone. */
  readonly invalidate: (key: EntraUserKey | 'all') => void;
  /** The Entra tenant of the users (AZURE_TENANT_ID). */
  readonly tenantId: string;
}

export interface AdminHandlerOptions {
  readonly authenticator: RequestAuthenticator;
  readonly data: AdminDataService;
  readonly runner: AdminJobRunner;
  readonly identity?: AdminIdentityControls;
  readonly audit: EventStore<AuditEvent>;
  readonly configuration: () => readonly ConfigurationSection[];
  readonly clientConfig: AdminClientConfig;
  /** e.g. https://ehub-api.example.com; when unset, the request's own Host is the origin. */
  readonly publicOrigin?: string;
  /** Hosts the page may connect to for sign-in (the Entra authority). */
  readonly authorityOrigin: string;
  readonly uiDirectory: string;
  readonly msalBundlePath: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_request'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'confirmation_required'
  | 'origin_rejected'
  | 'course_not_included'
  | 'resource_not_failing'
  | 'job_running'
  | 'identity_not_configured'
  | 'moodle_account_not_active'
  | 'mapping_not_found'
  | 'moodle_unavailable'
  | 'authentication_unavailable'
  | 'internal_error';

const STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_request: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  confirmation_required: 400,
  origin_rejected: 403,
  course_not_included: 403,
  resource_not_failing: 409,
  job_running: 409,
  identity_not_configured: 409,
  moodle_account_not_active: 422,
  mapping_not_found: 404,
  moodle_unavailable: 503,
  authentication_unavailable: 503,
  internal_error: 500,
};

const MESSAGES: Readonly<Record<ErrorCode, string>> = {
  unauthenticated: 'Sign in to use the administration area.',
  forbidden: 'Your account does not have the role this needs.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  invalid_request: 'The request is not valid.',
  unsupported_media_type: 'Send JSON (Content-Type: application/json).',
  payload_too_large: 'The request is too large.',
  confirmation_required: 'This action must be confirmed.',
  origin_rejected: 'The request did not come from the administration page.',
  course_not_included: 'That course is not included in synchronisation.',
  resource_not_failing: 'That resource is not in a failed state.',
  job_running: 'A manual job is already running. Wait for it to finish.',
  identity_not_configured: 'Moodle identity mapping is not configured on this server.',
  moodle_account_not_active: 'Moodle does not report that account as existing and active.',
  mapping_not_found: 'There is no explicit mapping for that user.',
  moodle_unavailable: 'Moodle could not be reached. Try again shortly.',
  authentication_unavailable: 'Sign-in cannot be checked right now.',
  internal_error: 'Something went wrong.',
};

class AdminError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly reason?: string,
  ) {
    super(code);
    this.name = 'AdminError';
  }
}

const guid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  .transform((value) => value.toLowerCase());
const courseId = z.number().int().positive().max(2_147_483_647);
const confirm = z.literal(true);

const BODIES = {
  incremental: z.strictObject({}),
  reindex: z.strictObject({ courseId, confirm: confirm.optional() }),
  retry: z.strictObject({ courseId, resourceId: z.string().min(1).max(1100) }),
  refresh: z.discriminatedUnion('scope', [
    z.strictObject({ scope: z.literal('user'), entraObjectId: guid }),
    z.strictObject({ scope: z.literal('all'), confirm: confirm.optional() }),
  ]),
  map: z.strictObject({
    entraObjectId: guid,
    moodleUserId: z.number().int().positive().max(2_147_483_647),
    reference: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._#:/-]{0,99}$/)
      .optional(),
    confirm: confirm.optional(),
  }),
  unmap: z.strictObject({ entraObjectId: guid, confirm: confirm.optional() }),
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function securityHeaders(authorityOrigin: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    // No inline script or style anywhere; MSAL's silent renewal needs the authority in a frame.
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      `connect-src 'self' ${authorityOrigin}`,
      `frame-src ${authorityOrigin}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}

/**
 * The administration area: a static page under /admin and a JSON API under /admin/api. Every
 * API request is authenticated with the same Entra validation as the answer API, and every
 * permission is checked here, on the server, from the token's app roles.
 *
 * CSRF: the API authenticates with a bearer token the page sends explicitly, never a cookie,
 * so a forged cross-site request carries no credentials. Mutations also require JSON (which a
 * cross-site form cannot send without a CORS preflight, which is never granted) and, when the
 * browser sends one, an Origin equal to the administration page's origin.
 */
export function createAdminHandler(
  options: AdminHandlerOptions,
): (request: IncomingMessage, response: ServerResponse, correlationId: string) => Promise<void> {
  const logger = options.logger.child({ component: 'admin' });
  const now = options.now ?? (() => new Date());
  const headers = securityHeaders(options.authorityOrigin);

  const sendJson = (
    response: ServerResponse,
    status: number,
    body: unknown,
    correlationId: string,
  ) => {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'x-correlation-id': correlationId,
      'content-length': Buffer.byteLength(text),
    });
    response.end(text);
  };

  const sendError = (response: ServerResponse, error: AdminError, correlationId: string) => {
    if (error.code === 'unauthenticated') {
      response.setHeader('www-authenticate', 'Bearer');
    }
    sendJson(
      response,
      STATUS[error.code],
      {
        error: {
          code: error.code,
          message: MESSAGES[error.code],
          ...(error.reason === undefined ? {} : { reason: error.reason }),
        },
        correlationId,
      },
      correlationId,
    );
  };

  const authenticate = async (request: IncomingMessage): Promise<AuthenticatedCaller> => {
    const result = await options.authenticator.authenticate(request.headers);
    if (result.kind === 'authenticated') {
      return result.caller;
    }
    if (result.kind === 'unavailable' || result.kind === 'not_configured') {
      throw new AdminError('authentication_unavailable');
    }
    if (result.kind === 'forbidden') {
      throw new AdminError('forbidden');
    }
    logger.warn('Admin authentication failed.', { reason: result.reason });
    throw new AdminError('unauthenticated');
  };

  const require = (caller: AuthenticatedCaller, permission: Permission): void => {
    if (!permissionsOf(caller.identity.roles).has(permission)) {
      throw new AdminError('forbidden');
    }
  };

  const checkOrigin = (request: IncomingMessage): void => {
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site') {
      throw new AdminError('origin_rejected');
    }
    const origin = request.headers.origin;
    if (origin === undefined) {
      return;
    }
    const expected =
      options.publicOrigin === undefined ? undefined : new URL(options.publicOrigin).origin;
    const host = request.headers.host;
    const own =
      expected ?? (host === undefined ? undefined : [`https://${host}`, `http://${host}`]);
    const allowed = Array.isArray(own) ? own : own === undefined ? [] : [own];
    if (!allowed.includes(origin)) {
      throw new AdminError('origin_rejected');
    }
  };

  const readBody = async <T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> => {
    const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      throw new AdminError('unsupported_media_type');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new AdminError('payload_too_large');
      }
      chunks.push(buffer);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AdminError('invalid_request');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AdminError('invalid_request');
    }
    return parsed.data;
  };

  const audit = async (
    caller: AuthenticatedCaller,
    action: AdminAction,
    outcome: AuditEvent['outcome'],
    correlationId: string,
    target?: AuditEvent['target'],
    reason?: string,
  ): Promise<void> => {
    const event: AuditEvent = {
      at: now().toISOString(),
      action,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      actor: {
        objectId: caller.identity.objectId,
        roles: adminRolesOf(caller.identity.roles),
        method: caller.identity.authentication.method,
      },
      ...(target === undefined ? {} : { target }),
      correlationId,
    };
    try {
      await options.audit.append(event);
    } catch (error) {
      logger.error('Could not write the audit record.', {
        action,
        outcome,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw new AdminError('internal_error');
    }
  };

  /** Runs a mutation with its audit record, whatever the outcome. */
  const mutation = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: string,
    caller: AuthenticatedCaller,
    action: AdminAction,
    permission: Permission,
    body: (
      target: (value: AuditEvent['target']) => void,
    ) => Promise<{ status: number; result: unknown }>,
  ): Promise<void> => {
    let target: AuditEvent['target'];
    try {
      require(caller, permission);
      checkOrigin(request);
      const { status, result } = await body((value) => {
        target = value;
      });
      await audit(caller, action, 'accepted', correlationId, target);
      sendJson(response, status, result, correlationId);
    } catch (error) {
      const known = error instanceof AdminError ? error : undefined;
      const outcome = known === undefined || STATUS[known.code] >= 500 ? 'failed' : 'refused';
      await audit(
        caller,
        action,
        outcome,
        correlationId,
        target,
        known?.reason ?? known?.code ?? 'internal_error',
      );
      throw error;
    }
  };

  const identityControls = (): AdminIdentityControls => {
    if (options.identity === undefined) {
      throw new AdminError('identity_not_configured');
    }
    return options.identity;
  };

  const requireConfirm = (value: unknown): void => {
    if (value !== true) {
      throw new AdminError('confirmation_required');
    }
  };

  const startJob = (job: Parameters<AdminJobRunner['start']>[0], correlationId: string) => {
    try {
      return options.runner.start(job, correlationId);
    } catch (error) {
      if (error instanceof JobRunnerBusyError) {
        throw new AdminError('job_running');
      }
      throw error;
    }
  };

  const api = async (
    request: IncomingMessage,
    response: ServerResponse,
    route: string,
    correlationId: string,
  ): Promise<void> => {
    const method = request.method ?? 'GET';
    if (route === 'client-config') {
      if (method !== 'GET') {
        throw new AdminError('method_not_allowed');
      }
      sendJson(response, 200, options.clientConfig, correlationId);
      return;
    }
    const caller = await authenticate(request);
    const permissions = permissionsOf(caller.identity.roles);
    const reads: Record<
      string,
      { permission: Permission | undefined; load: () => Promise<unknown> }
    > = {
      me: {
        permission: undefined,
        load: () =>
          Promise.resolve({
            objectId: caller.identity.objectId,
            displayName: caller.identity.displayName ?? null,
            roles: adminRolesOf(caller.identity.roles),
            permissions: [...permissions],
            mock: caller.mock,
          }),
      },
      dashboard: { permission: 'view:content', load: () => options.data.dashboard() },
      courses: { permission: 'view:content', load: () => options.data.courses() },
      jobs: { permission: 'view:content', load: () => options.data.jobs(50) },
      failures: { permission: 'view:content', load: () => options.data.failures() },
      identity: { permission: 'view:identity', load: () => options.data.identity() },
      configuration: {
        permission: 'view:configuration',
        load: () => Promise.resolve({ sections: options.configuration() }),
      },
      audit: { permission: 'view:audit', load: () => options.data.audit(30, 500) },
    };
    const read = Object.hasOwn(reads, route) ? reads[route] : undefined;
    if (read !== undefined) {
      if (method !== 'GET') {
        throw new AdminError('method_not_allowed');
      }
      if (read.permission !== undefined) {
        require(caller, read.permission);
      }
      sendJson(response, 200, await read.load(), correlationId);
      return;
    }
    if (method !== 'POST') {
      throw new AdminError(
        [
          'actions/incremental-sync',
          'actions/reindex',
          'actions/retry',
          'actions/enrolment-refresh',
          'identity/mappings',
          'identity/mappings/remove',
        ].includes(route)
          ? 'method_not_allowed'
          : 'not_found',
      );
    }
    switch (route) {
      case 'actions/incremental-sync':
        await mutation(
          request,
          response,
          correlationId,
          caller,
          'sync.incremental',
          'action:sync',
          async (target) => {
            await readBody(request, BODIES.incremental);
            const { jobId } = startJob({ kind: 'incremental' }, correlationId);
            target({ jobId });
            return { status: 202, result: { status: 'started', jobId } };
          },
        );
        return;
      case 'actions/reindex':
        await mutation(
          request,
          response,
          correlationId,
          caller,
          'course.reindex',
          'action:reindex',
          async (target) => {
            const body = await readBody(request, BODIES.reindex);
            target({ courseId: body.courseId });
            // Only courses already selected for synchronisation: an ID typed by hand can never
            // make the service account read a course it was not meant to index.
            if (!options.data.isCourseIncluded(body.courseId)) {
              throw new AdminError('course_not_included');
            }
            requireConfirm(body.confirm);
            const { jobId } = startJob({ kind: 'reindex', courseId: body.courseId }, correlationId);
            target({ courseId: body.courseId, jobId });
            return { status: 202, result: { status: 'started', jobId } };
          },
        );
        return;
      case 'actions/retry':
        await mutation(
          request,
          response,
          correlationId,
          caller,
          'resource.retry',
          'action:retry',
          async (target) => {
            const body = await readBody(request, BODIES.retry);
            target({ courseId: body.courseId, resourceId: body.resourceId });
            if (!options.data.isCourseIncluded(body.courseId)) {
              throw new AdminError('course_not_included');
            }
            // Only resources the state store lists as failed: never an arbitrary resource ID.
            if (!(await options.data.isFailing(body.courseId, body.resourceId))) {
              throw new AdminError('resource_not_failing');
            }
            const { jobId } = startJob(
              { kind: 'retry', courseId: body.courseId, resourceId: body.resourceId },
              correlationId,
            );
            target({ courseId: body.courseId, resourceId: body.resourceId, jobId });
            return { status: 202, result: { status: 'started', jobId } };
          },
        );
        return;
      case 'actions/enrolment-refresh':
        await mutation(
          request,
          response,
          correlationId,
          caller,
          'enrolment.refresh',
          'action:enrolment-refresh',
          async (target) => {
            const body = await readBody(request, BODIES.refresh);
            const controls = identityControls();
            const at = now().toISOString();
            if (body.scope === 'all') {
              target({ scope: 'all' });
              requireConfirm(body.confirm);
              await controls.repository.addInvalidation({ scope: 'all', at, reason: 'admin' });
              controls.invalidate('all');
            } else {
              target({ scope: 'user', entraObjectId: body.entraObjectId });
              const key = { tenantId: controls.tenantId, objectId: body.entraObjectId };
              await controls.repository.addInvalidation({ scope: key, at, reason: 'admin' });
              controls.invalidate(key);
            }
            return { status: 200, result: { status: 'refreshed', scope: body.scope } };
          },
        );
        return;
      case 'identity/mappings':
        await mutation(
          request,
          response,
          correlationId,
          caller,
          'identity.map',
          'action:identity',
          async (target) => {
            const body = await readBody(request, BODIES.map);
            target({ entraObjectId: body.entraObjectId, moodleUserId: body.moodleUserId });
            const controls = identityControls();
            requireConfirm(body.confirm);
            let check;
            try {
              check = await controls.resolver.checkAccount(body.moodleUserId);
            } catch (error) {
              if (error instanceof AuthorizationUnavailableError) {
                throw new AdminError('moodle_unavailable');
              }
              throw error;
            }
            if (check.status !== 'mapped') {
              throw new AdminError('moodle_account_not_active', check.reason);
            }
            const key = { tenantId: controls.tenantId, objectId: body.entraObjectId };
            const at = now().toISOString();
            await controls.repository.saveMapping({
              ...key,
              moodleUserId: body.moodleUserId,
              approvedBy: caller.identity.objectId,
              approvedAt: at,
              ...(body.reference === undefined ? {} : { reference: body.reference }),
            });
            await controls.repository.addInvalidation({
              scope: key,
              at,
              reason: 'mapping_changed',
            });
            controls.invalidate(key);
            return {
              status: 200,
              result: {
                status: 'mapped',
                entraObjectId: key.objectId,
                moodleUserId: body.moodleUserId,
              },
            };
          },
        );
        return;
      case 'identity/mappings/remove':
        await mutation(
          request,
          response,
          correlationId,
          caller,
          'identity.unmap',
          'action:identity',
          async (target) => {
            const body = await readBody(request, BODIES.unmap);
            target({ entraObjectId: body.entraObjectId });
            const controls = identityControls();
            requireConfirm(body.confirm);
            const key = { tenantId: controls.tenantId, objectId: body.entraObjectId };
            if (!(await controls.repository.deleteMapping(key))) {
              throw new AdminError('mapping_not_found');
            }
            await controls.repository.addInvalidation({
              scope: key,
              at: now().toISOString(),
              reason: 'mapping_changed',
            });
            controls.invalidate(key);
            return { status: 200, result: { status: 'removed', entraObjectId: key.objectId } };
          },
        );
        return;
      default:
        throw new AdminError('not_found');
    }
  };

  const staticFile = async (
    response: ServerResponse,
    name: string,
    file: string,
  ): Promise<void> => {
    const extension = name.slice(name.lastIndexOf('.'));
    const body = await readFile(file);
    response.writeHead(200, {
      ...headers,
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'content-length': body.byteLength,
    });
    response.end(body);
  };

  const STATIC: Readonly<Record<string, string>> = {
    '/admin': join(options.uiDirectory, 'index.html'),
    '/admin/': join(options.uiDirectory, 'index.html'),
    '/admin/app.js': join(options.uiDirectory, 'app.js'),
    '/admin/app.css': join(options.uiDirectory, 'app.css'),
    '/admin/vendor/msal-browser.min.js': options.msalBundlePath,
  };

  return async (request, response, correlationId) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    try {
      if (path.startsWith(API_PREFIX)) {
        await api(request, response, path.slice(API_PREFIX.length), correlationId);
        return;
      }
      const file = Object.hasOwn(STATIC, path) ? STATIC[path] : undefined;
      if (file === undefined) {
        throw new AdminError('not_found');
      }
      if (request.method !== 'GET') {
        throw new AdminError('method_not_allowed');
      }
      await staticFile(
        response,
        path === '/admin' || path === '/admin/' ? 'index.html' : path,
        file,
      );
    } catch (error) {
      request.resume();
      if (response.headersSent) {
        return;
      }
      if (error instanceof AdminError) {
        sendError(response, error, correlationId);
        return;
      }
      logger.error('Admin request failed.', {
        path,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      sendError(response, new AdminError('internal_error'), correlationId);
    }
  };
}
