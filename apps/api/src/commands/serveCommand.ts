import {
  EXIT_FAILURE,
  EXIT_OK,
  apiServerConfigSchema,
  loadConfig,
  parseCommandArgs,
  readPackageVersion,
  sanitizeText,
  type CommandDefinition,
} from '@ehub/shared';
import { z } from 'zod';

import { startApiServer, type RunningApiServer } from '../http/apiServer.js';
import {
  DevMockAuthenticator,
  noAuthenticator,
  type RequestAuthenticator,
} from '../http/authentication.js';
import { LoggingFeedbackRecorder, type FeedbackRecorder } from '../http/feedbackRecorder.js';
import { openRagService, describeAskFailure, type AskCommandDependencies } from './askCommand.js';
import { SERVICE_NAME } from './health.js';
import { withErrorHandling } from './retrievalCommands.js';

export interface ServeCommandDependencies extends AskCommandDependencies {
  readonly createFeedbackRecorder?: () => FeedbackRecorder;
  /** Resolves when the server should stop; SIGINT/SIGTERM by default. */
  readonly waitForShutdown?: (server: RunningApiServer) => Promise<void>;
}

const serveArgs = z.object({}).strict();

export const PRODUCTION_BLOCKED_MESSAGE =
  'The answer API cannot run in production yet: Microsoft Entra ID sign-in (phase 13) is required to identify callers.';

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
 * `pnpm api serve`: the HTTP answer API for the Teams app. Development only until phase 13; the
 * only identity is the explicitly enabled mock identity, and without it every question is
 * refused (fail closed).
 */
export function createServeCommand(dependencies: ServeCommandDependencies): CommandDefinition {
  return {
    description:
      'Run the HTTP answer API (development only until Entra SSO; see docs/teams-app.md).',
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
          const authenticator: RequestAuthenticator = config.API_DEV_MOCK_IDENTITY
            ? new DevMockAuthenticator({
                nodeEnv: config.NODE_ENV,
                userId: config.API_DEV_MOCK_USER_ID,
                authorizedCourseIds: config.API_DEV_MOCK_COURSE_IDS ?? [],
              })
            : noAuthenticator;
          const { rag, tenantId } = await openRagService(dependencies, context.logger);
          const server = await startApiServer(
            {
              answerer: rag,
              authenticator,
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
          });
          context.stdout(
            [
              `Answer API listening on ${sanitizeText(server.url, 100)}`,
              authenticator.mode === 'dev-mock'
                ? `  DEVELOPMENT MOCK IDENTITY: ${sanitizeText(config.API_DEV_MOCK_USER_ID, 60)}, courses ${(config.API_DEV_MOCK_COURSE_IDS ?? []).join(', ')}`
                : '  No identity configured: every question is refused (set API_DEV_MOCK_IDENTITY=true for local development).',
            ].join('\n'),
          );
          await (dependencies.waitForShutdown ?? defaultWaitForShutdown)(server);
          await server.close();
          context.logger.info('Answer API stopped.');
          return EXIT_OK;
        },
        describeAskFailure,
      ),
  };
}
