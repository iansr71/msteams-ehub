import {
  EXIT_FAILURE,
  EXIT_OK,
  adminConfigSchema,
  apiServerConfigSchema,
  cleanEnvironment,
  entraAuthConfigSchema,
  loadConfig,
  parseCommandArgs,
  readPackageVersion,
  sanitizeText,
  type CommandDefinition,
  type EnvironmentSource,
} from '@ehub/shared';
import type { FetchFn } from '@ehub/moodle-client';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import { reportSyncGauges } from '@ehub/indexer';

import { createApiReadiness } from '../health/apiReadiness.js';
import { startApiServer, type RunningApiServer } from '../http/apiServer.js';
import { InterimCourseAccess, type CourseAccessResolver } from '../auth/courseAccess.js';
import {
  createAuthorizationServices,
  moodleAuthorizationConfigured,
  type AuthorizationMoodle,
} from '../authorization/factory.js';
import type { IdentityMappingRepository } from '../authorization/identityMappingRepository.js';
import { AnswerOutcomeRecorder, StoringFeedbackRecorder } from '../admin/events.js';
import { AdminSetupError, createAdminArea, type AdminDependencies } from '../admin/factory.js';
import { EntraTokenValidator, entraSigningKeys } from '../auth/entraTokenValidator.js';
import { createAuthenticator } from '../http/authentication.js';
import { LoggingFeedbackRecorder, type FeedbackRecorder } from '../http/feedbackRecorder.js';
import { openRagService, describeAskFailure, type AskCommandDependencies } from './askCommand.js';
import { SERVICE_NAME } from './health.js';
import { withErrorHandling } from './retrievalCommands.js';

export interface ServeCommandDependencies extends AskCommandDependencies {
  readonly createFeedbackRecorder?: () => FeedbackRecorder;
  /** Resolves when the server should stop; SIGINT/SIGTERM by default. */
  readonly waitForShutdown?: (server: RunningApiServer) => Promise<void>;
  /** For tests: signing keys instead of the tenant's published JWKS. */
  readonly signingKeys?: JWTVerifyGetKey;
  /** For tests: Moodle user and enrolment lookups instead of the MOODLE_* client. */
  readonly authorizationMoodle?: AuthorizationMoodle;
  /** For tests: the identity store instead of the file store under IDENTITY_STATE_DIR. */
  readonly identityRepository?: IdentityMappingRepository;
  /** For tests: the HTTP transport of the real Moodle client. */
  readonly moodleFetch?: FetchFn;
  /** For tests: administration area seams (sync state, stores, job runner). */
  readonly admin?: Omit<AdminDependencies, 'env'>;
}

/** Entra validation is configured when the API's registration is named. */
function entraConfigured(env: EnvironmentSource): boolean {
  const cleaned = cleanEnvironment(env);
  return (
    cleaned['ENTRA_API_CLIENT_ID'] !== undefined ||
    cleaned['ENTRA_ALLOWED_CLIENT_APP_IDS'] !== undefined
  );
}

const serveArgs = z.object({}).strict();

const SYNC_GAUGE_INTERVAL_MS = 5 * 60_000;

export const PRODUCTION_REQUIREMENTS_MESSAGE =
  'In production the answer API needs Entra ID sign-in (ENTRA_API_CLIENT_ID, ENTRA_ALLOWED_CLIENT_APP_IDS) and Moodle course authorisation (MOODLE_TOKEN): see docs/authorization.md.';

function defaultWaitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * `pnpm api serve`: the HTTP answer API for the Teams app. Callers prove who they are with an
 * Entra ID access token (or, in development only, the mock identity), and may ask only about
 * their own Moodle courses, decided from Moodle enrolments before retrieval. Production refuses
 * to start without both; without an identity every question is refused (fail closed).
 */
export function createServeCommand(dependencies: ServeCommandDependencies): CommandDefinition {
  return {
    description:
      'Run the HTTP answer API (Entra ID sign-in, Moodle course authorisation; see docs/authorization.md).',
    run: (context) =>
      withErrorHandling(
        context,
        'Answer API',
        async () => {
          parseCommandArgs(context.args, {}, serveArgs);
          const authorizationDependencies = {
            env: dependencies.env,
            ...(dependencies.authorizationMoodle === undefined
              ? {}
              : { moodle: dependencies.authorizationMoodle }),
            ...(dependencies.identityRepository === undefined
              ? {}
              : { identityRepository: dependencies.identityRepository }),
            ...(dependencies.moodleFetch === undefined
              ? {}
              : { moodleFetch: dependencies.moodleFetch }),
          };
          // Checked before loading anything else: production never starts without real
          // identity and real course authorisation.
          if (
            cleanEnvironment(dependencies.env)['NODE_ENV'] === 'production' &&
            !(
              entraConfigured(dependencies.env) &&
              moodleAuthorizationConfigured(authorizationDependencies)
            )
          ) {
            context.stdout(PRODUCTION_REQUIREMENTS_MESSAGE);
            return EXIT_FAILURE;
          }
          const config = loadConfig(apiServerConfigSchema, dependencies.env);
          const entra = entraConfigured(dependencies.env)
            ? loadConfig(entraAuthConfigSchema, dependencies.env)
            : undefined;
          const { rag, tenantId, probes } = await openRagService(dependencies, context.logger);
          const authenticator = createAuthenticator(
            {
              nodeEnv: config.NODE_ENV,
              tenantId,
              mockIdentity: config.API_DEV_MOCK_IDENTITY,
              mockUserId: config.API_DEV_MOCK_USER_ID,
              ...(config.API_DEV_MOCK_ROLES === undefined
                ? {}
                : { mockRoles: config.API_DEV_MOCK_ROLES }),
              ...(entra === undefined
                ? {}
                : {
                    entra: new EntraTokenValidator({
                      allowedTenantIds: entra.ENTRA_ALLOWED_TENANT_IDS ?? [entra.AZURE_TENANT_ID],
                      audiences: [
                        entra.ENTRA_API_CLIENT_ID,
                        ...(entra.ENTRA_API_APP_ID_URI === undefined
                          ? []
                          : [entra.ENTRA_API_APP_ID_URI]),
                      ],
                      requiredScope: entra.ENTRA_API_SCOPE,
                      allowedClientAppIds: entra.ENTRA_ALLOWED_CLIENT_APP_IDS,
                      keys:
                        dependencies.signingKeys ??
                        entraSigningKeys(entra.ENTRA_AUTHORITY_HOST, entra.AZURE_TENANT_ID),
                      authorityHost: entra.ENTRA_AUTHORITY_HOST,
                      clockToleranceSeconds: entra.ENTRA_CLOCK_TOLERANCE_SECONDS,
                    }),
                  }),
            },
            context.logger,
          );
          const authorization = moodleAuthorizationConfigured(authorizationDependencies)
            ? createAuthorizationServices(authorizationDependencies, context.logger, {
                mockCourseIds: config.API_DEV_MOCK_COURSE_IDS ?? [],
              })
            : undefined;
          const courseAccess: CourseAccessResolver =
            authorization?.courses ??
            new InterimCourseAccess({
              nodeEnv: config.NODE_ENV,
              mockCourseIds: config.API_DEV_MOCK_COURSE_IDS ?? [],
              devEntraCourseIds: config.API_DEV_ENTRA_COURSE_IDS ?? [],
            });
          const adminEnabled = loadConfig(adminConfigSchema, dependencies.env).ADMIN_UI_ENABLED;
          const admin = adminEnabled
            ? createAdminArea({
                dependencies: { ...dependencies.admin, env: dependencies.env },
                authenticator,
                entra,
                authorization,
                mockUserId: config.API_DEV_MOCK_IDENTITY ? config.API_DEV_MOCK_USER_ID : undefined,
                logger: context.logger,
              })
            : undefined;
          const readiness = createApiReadiness({
            ...probes,
            authorization,
            ...(admin === undefined ? {} : { syncState: admin.syncState }),
            logger: context.logger,
          });
          // Sync lag and resource gauges, so a stalled scheduler shows up in monitoring.
          const gauges =
            admin === undefined
              ? undefined
              : setInterval(() => {
                  reportSyncGauges(admin.syncState, admin.tenantId, new Date()).catch(
                    (error: unknown) => {
                      context.logger.warn('Sync gauges could not be reported.', {
                        errorType: error instanceof Error ? error.name : typeof error,
                      });
                    },
                  );
                }, SYNC_GAUGE_INTERVAL_MS);
          gauges?.unref();
          const logFeedback =
            dependencies.createFeedbackRecorder?.() ?? new LoggingFeedbackRecorder(context.logger);
          const server = await startApiServer(
            {
              answerer: rag,
              authenticator,
              courseAccess,
              ...(entra === undefined ? {} : { requiredScope: entra.ENTRA_API_SCOPE }),
              feedback:
                admin === undefined
                  ? logFeedback
                  : new StoringFeedbackRecorder(admin.stores.usage, logFeedback),
              readiness,
              ...(admin === undefined
                ? {}
                : {
                    admin: admin.handler,
                    answerOutcomes: new AnswerOutcomeRecorder(admin.stores.usage, context.logger),
                  }),
              tenantId,
              requestTimeoutMs: config.API_REQUEST_TIMEOUT_MS,
              logger: context.logger,
              service: SERVICE_NAME,
              version: readPackageVersion(new URL('../../package.json', import.meta.url)),
            },
            { host: config.API_HOST, port: config.PORT },
          );
          context.logger.info('Answer API listening.', {
            url: server.url,
            identityMode: authenticator.mode,
            courseAccess: courseAccess.mode,
          });
          const lines = [`Answer API listening on ${sanitizeText(server.url, 100)}`];
          if (admin !== undefined) {
            lines.push(
              `  Administration: ${sanitizeText(server.url, 100)}/admin (${admin.clientMode === 'msal' ? 'Entra sign-in' : admin.clientMode === 'dev-mock' ? 'DEVELOPMENT MOCK IDENTITY' : 'sign-in not configured'})`,
            );
          }
          if (authenticator.mode.includes('entra')) {
            lines.push(
              `  Entra ID sign-in: tenant ${entra?.AZURE_TENANT_ID ?? ''}, scope ${entra?.ENTRA_API_SCOPE ?? ''}`,
              courseAccess.mode === 'moodle-enrolments'
                ? '  Course access: Moodle enrolments (identity mapping and enrolments, cached briefly).'
                : courseAccess.mode === 'dev-static'
                  ? `  DEVELOPMENT COURSE ACCESS for every signed-in user: ${(config.API_DEV_ENTRA_COURSE_IDS ?? []).join(', ')}`
                  : '  No course access source (MOODLE_TOKEN not set): signed-in users are refused with "no access".',
            );
          }
          if (authenticator.mode.includes('dev-mock')) {
            lines.push(
              `  DEVELOPMENT MOCK IDENTITY: ${sanitizeText(config.API_DEV_MOCK_USER_ID, 60)}, courses ${(config.API_DEV_MOCK_COURSE_IDS ?? []).join(', ')}`,
            );
          }
          if (authenticator.mode === 'none') {
            lines.push(
              '  No identity configured: every question is refused (see docs/entra-sso.md).',
            );
          }
          context.stdout(lines.join('\n'));
          await (dependencies.waitForShutdown ?? defaultWaitForShutdown)(server);
          await server.close();
          admin?.close();
          clearInterval(gauges);
          await admin?.runner.idle();
          context.logger.info('Answer API stopped.');
          return EXIT_OK;
        },
        (error) =>
          error instanceof AdminSetupError
            ? { status: 'error', error: { category: 'configuration', message: error.message } }
            : describeAskFailure(error),
      ),
  };
}
