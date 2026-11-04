import {
  TEAMS_DEFAULTS,
  loadConfig,
  readPackageVersion,
  teamsConfigSchema,
  type EnvironmentSource,
  type Logger,
} from '@ehub/shared';

import { HttpAnswerClient, type FetchLike } from './api/answerClient.js';
import { ConversationHandler } from './conversation/conversationHandler.js';
import {
  MockIdentityProvider,
  noIdentityProvider,
  type IdentityProvider,
} from './conversation/identity.js';
import { NodeHttpAdapter } from './teams/httpAdapter.js';
import { createTeamsBot, type TeamsBot } from './teams/teamsAdapter.js';

export const SERVICE_NAME = 'ehub-teams-app';

export const PRODUCTION_BLOCKED_MESSAGE =
  'The Teams app cannot run in production yet: Microsoft Entra ID single sign-on (phase 13) is required before users can be identified.';

export class TeamsStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsStartupError';
  }
}

export interface TeamsServerDependencies {
  readonly env: EnvironmentSource;
  readonly logger: Logger;
  /** For tests: how the bot reaches the answer API. */
  readonly fetch?: FetchLike;
  /** Interface to listen on (default all interfaces, for dev tunnels). */
  readonly host?: string;
  /** Overrides TEAMS_BOT_PORT (0 picks a free port). */
  readonly port?: number;
}

export interface RunningTeamsServer {
  readonly bot: TeamsBot;
  readonly port: number | undefined;
  readonly identityMode: IdentityProvider['mode'];
  stop(): Promise<void>;
}

/**
 * Starts the bot. Refuses production (no SSO yet), refuses to run with neither bot credentials
 * nor the explicit development opt-in for unsigned requests, and never holds Moodle or Azure
 * service credentials: answers come from the answer API.
 */
export async function startTeamsServer(
  dependencies: TeamsServerDependencies,
): Promise<RunningTeamsServer> {
  // Checked before anything else, so no configuration can make production start.
  if (dependencies.env['NODE_ENV'] === 'production') {
    throw new TeamsStartupError(PRODUCTION_BLOCKED_MESSAGE);
  }
  const config = loadConfig(teamsConfigSchema, dependencies.env);
  if (config.TEAMS_BOT_CLIENT_ID === undefined && !config.TEAMS_DEV_ALLOW_UNAUTHENTICATED) {
    throw new TeamsStartupError(
      'Set TEAMS_BOT_CLIENT_ID (and TEAMS_BOT_CLIENT_SECRET locally) so incoming Teams requests can be verified, or TEAMS_DEV_ALLOW_UNAUTHENTICATED=true for a local test tool such as Microsoft 365 Agents Playground.',
    );
  }
  const { logger } = dependencies;
  const identity: IdentityProvider = config.TEAMS_DEV_MOCK_IDENTITY
    ? new MockIdentityProvider({ nodeEnv: config.NODE_ENV, userId: config.TEAMS_DEV_MOCK_USER_ID })
    : noIdentityProvider;
  const handler = new ConversationHandler({
    answers: new HttpAnswerClient({
      baseUrl: config.TEAMS_API_BASE_URL ?? TEAMS_DEFAULTS.apiBaseUrl,
      timeoutMs: config.TEAMS_API_TIMEOUT_MS,
      logger,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    }),
    identity,
    logger,
    maxCardBytes: config.TEAMS_CARD_MAX_BYTES,
    allowedLinkHosts:
      config.TEAMS_ALLOWED_LINK_HOSTS === undefined
        ? undefined
        : new Set(config.TEAMS_ALLOWED_LINK_HOSTS),
    maxConcurrentQuestions: config.TEAMS_MAX_CONCURRENT_QUESTIONS,
  });
  const version = readPackageVersion(new URL('../package.json', import.meta.url));
  const http = new NodeHttpAdapter({
    logger,
    ...(dependencies.host === undefined ? {} : { host: dependencies.host }),
    health: () => ({
      status: identity.mode === 'none' ? 'degraded' : 'ok',
      service: SERVICE_NAME,
      version,
      identityMode: identity.mode,
      inFlightQuestions: handler.inFlight,
    }),
  });
  const bot = createTeamsBot({
    handler,
    logger,
    httpAdapter: http,
    allowUnauthenticated: config.TEAMS_DEV_ALLOW_UNAUTHENTICATED,
    ...(config.TEAMS_BOT_CLIENT_ID === undefined
      ? {}
      : {
          credentials: {
            clientId: config.TEAMS_BOT_CLIENT_ID,
            ...(config.TEAMS_BOT_CLIENT_SECRET === undefined
              ? {}
              : { clientSecret: config.TEAMS_BOT_CLIENT_SECRET }),
            ...(config.TEAMS_BOT_TENANT_ID === undefined
              ? {}
              : { tenantId: config.TEAMS_BOT_TENANT_ID }),
          },
        }),
  });
  await bot.app.start(dependencies.port ?? config.TEAMS_BOT_PORT);
  logger.info('Teams app started.', {
    identityMode: identity.mode,
    unauthenticatedRequestsAllowed: config.TEAMS_DEV_ALLOW_UNAUTHENTICATED,
    botCredentials: config.TEAMS_BOT_CLIENT_ID !== undefined,
  });
  return {
    bot,
    port: http.port,
    identityMode: identity.mode,
    stop: async () => {
      await bot.app.stop();
      await bot.tasks.idle();
    },
  };
}
