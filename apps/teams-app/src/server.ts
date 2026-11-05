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
  ssoIdentityProvider,
  type IdentityProvider,
} from './conversation/identity.js';
import { NodeHttpAdapter } from './teams/httpAdapter.js';
import {
  createTeamsBot,
  oauthConnectionSso,
  type SsoAdapter,
  type TeamsBot,
} from './teams/teamsAdapter.js';

export const SERVICE_NAME = 'ehub-teams-app';

export const PRODUCTION_BLOCKED_MESSAGE =
  'The Teams app cannot run in production yet: course access from Moodle enrolments (phase 14) is required before real users can be authorised.';

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
  /** For tests: replaces the Azure Bot OAuth connection. */
  readonly sso?: SsoAdapter;
}

export interface RunningTeamsServer {
  readonly bot: TeamsBot;
  readonly port: number | undefined;
  readonly identityMode: IdentityProvider['mode'];
  /** True only in development with TEAMS_DEV_ALLOW_UNAUTHENTICATED. */
  readonly unauthenticatedRequestsAllowed: boolean;
  stop(): Promise<void>;
}

/**
 * Starts the bot. Refuses production (no course authorisation yet), refuses to run with
 * neither bot credentials nor the explicit development opt-in for unsigned requests, and never holds Moodle or Azure
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
  const { logger } = dependencies;
  const development = config.NODE_ENV === 'development';
  // Development switches are turned off automatically elsewhere, so a stray variable is harmless.
  for (const [name, set] of [
    ['TEAMS_DEV_MOCK_IDENTITY', config.TEAMS_DEV_MOCK_IDENTITY],
    ['TEAMS_DEV_ALLOW_UNAUTHENTICATED', config.TEAMS_DEV_ALLOW_UNAUTHENTICATED],
  ] as const) {
    if (set && !development) {
      logger.warn(`${name} ignored: it only works with NODE_ENV=development.`, {
        nodeEnv: config.NODE_ENV,
      });
    }
  }
  const allowUnauthenticated = development && config.TEAMS_DEV_ALLOW_UNAUTHENTICATED;
  const sso =
    dependencies.sso ??
    (config.TEAMS_SSO_CONNECTION_NAME === undefined
      ? undefined
      : oauthConnectionSso(config.TEAMS_SSO_CONNECTION_NAME));
  if (
    sso !== undefined &&
    config.TEAMS_BOT_CLIENT_ID === undefined &&
    dependencies.sso === undefined
  ) {
    throw new TeamsStartupError(
      'Teams single sign-on needs the bot registration: set TEAMS_BOT_CLIENT_ID (see docs/entra-sso.md).',
    );
  }
  if (config.TEAMS_BOT_CLIENT_ID === undefined && !allowUnauthenticated) {
    throw new TeamsStartupError(
      'Set TEAMS_BOT_CLIENT_ID (and TEAMS_BOT_CLIENT_SECRET locally) so incoming Teams requests can be verified, or TEAMS_DEV_ALLOW_UNAUTHENTICATED=true for a local test tool such as Microsoft 365 Agents Playground.',
    );
  }
  // SSO wins when configured; the mock is a development fallback only.
  let identity: IdentityProvider = noIdentityProvider;
  if (sso !== undefined) {
    identity = ssoIdentityProvider;
    if (config.TEAMS_DEV_MOCK_IDENTITY) {
      logger.warn('TEAMS_DEV_MOCK_IDENTITY ignored: Teams single sign-on is configured.');
    }
  } else if (development && config.TEAMS_DEV_MOCK_IDENTITY) {
    identity = new MockIdentityProvider({
      nodeEnv: config.NODE_ENV,
      userId: config.TEAMS_DEV_MOCK_USER_ID,
    });
  }
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
    allowUnauthenticated,
    ...(sso === undefined ? {} : { sso }),
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
    unauthenticatedRequestsAllowed: allowUnauthenticated,
    botCredentials: config.TEAMS_BOT_CLIENT_ID !== undefined,
  });
  return {
    bot,
    port: http.port,
    identityMode: identity.mode,
    unauthenticatedRequestsAllowed: allowUnauthenticated,
    stop: async () => {
      await bot.app.stop();
      await bot.tasks.idle();
    },
  };
}
