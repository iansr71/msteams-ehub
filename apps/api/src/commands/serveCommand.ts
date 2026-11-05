import {
  EXIT_FAILURE,
  EXIT_OK,
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
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import { startApiServer, type RunningApiServer } from '../http/apiServer.js';
import { InterimCourseAccess } from '../auth/courseAccess.js';
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

export const PRODUCTION_BLOCKED_MESSAGE =
  'The answer API cannot run in production yet: course access from Moodle enrolments (phase 14) is required before real users can be authorised.';

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
 * Entra ID access token (or, in development only, the mock identity). Production is refused
 * until phase 14 limits users to their enrolled courses; without an identity every question is
 * refused (fail closed).
 */
export function createServeCommand(dependencies: ServeCommandDependencies): CommandDefinition {
  return {
    description:
      'Run the HTTP answer API (development only until enrolment-based access; see docs/entra-sso.md).',
    run: (context) =>
      withErrorHandling(
        context,
        'Answer API',
        async () => {
          parseCommandArgs(context.args, {}, serveArgs);
          // Checked before anything else, so no configuration can make production start.
          if (dependencies.env['NODE_ENV'] === 'production') {
            context.stdout(PRODUCTION_BLOCKED_MESSAGE);
            return EXIT_FAILURE;
          }
          const config = loadConfig(apiServerConfigSchema, dependencies.env);
          const entra = entraConfigured(dependencies.env)
            ? loadConfig(entraAuthConfigSchema, dependencies.env)
            : undefined;
          const { rag, tenantId } = await openRagService(dependencies, context.logger);
          const authenticator = createAuthenticator(
            {
              nodeEnv: config.NODE_ENV,
              tenantId,
              mockIdentity: config.API_DEV_MOCK_IDENTITY,
              mockUserId: config.API_DEV_MOCK_USER_ID,
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
          const courseAccess = new InterimCourseAccess({
            nodeEnv: config.NODE_ENV,
            mockCourseIds: config.API_DEV_MOCK_COURSE_IDS ?? [],
            devEntraCourseIds: config.API_DEV_ENTRA_COURSE_IDS ?? [],
          });
          const server = await startApiServer(
            {
              answerer: rag,
              authenticator,
              courseAccess,
              ...(entra === undefined ? {} : { requiredScope: entra.ENTRA_API_SCOPE }),
              feedback:
                dependencies.createFeedbackRecorder?.() ??
                new LoggingFeedbackRecorder(context.logger),
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
          if (authenticator.mode.includes('entra')) {
            lines.push(
              `  Entra ID sign-in: tenant ${entra?.AZURE_TENANT_ID ?? ''}, scope ${entra?.ENTRA_API_SCOPE ?? ''}`,
              courseAccess.mode === 'dev-static'
                ? `  DEVELOPMENT COURSE ACCESS for every signed-in user: ${(config.API_DEV_ENTRA_COURSE_IDS ?? []).join(', ')}`
                : '  No course access source yet (phase 14): signed-in users are refused with "no access".',
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
          context.logger.info('Answer API stopped.');
          return EXIT_OK;
        },
        describeAskFailure,
      ),
  };
}
