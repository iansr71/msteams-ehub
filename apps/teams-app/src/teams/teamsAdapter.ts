import {
  generateCorrelationId,
  runWithCorrelationId,
  sanitizeText,
  type Logger,
} from '@ehub/shared';
import {
  App,
  type AppOptions,
  type IActivityContext,
  type IHttpServerAdapter,
  type IPlugin,
} from '@microsoft/teams.apps';
import type { IAdaptiveCard } from '@microsoft/teams.cards';

import type { AdaptiveCard } from '../cards/adaptiveCard.js';
import type { TurnSignIn } from '../conversation/identity.js';
import type {
  ConversationHandler,
  ConversationType,
  OutgoingMessage,
  ReplySink,
  TurnInfo,
} from '../conversation/conversationHandler.js';

type SdkLogger = NonNullable<AppOptions<IPlugin>['logger']>;

/**
 * The SDK logs whole activities at debug level, and activities contain the user's question.
 * Only the SDK's message string is kept (sanitised and bounded); every other argument is
 * dropped, except the name of an Error.
 */
export function sdkLogger(logger: Logger, name = 'teams-sdk'): SdkLogger {
  const child = logger.child({ component: name });
  const describe = (args: unknown[]): { message: string; errorName?: string } => {
    const message = typeof args[0] === 'string' ? sanitizeText(args[0], 200) : 'SDK event';
    const error = args.find((arg): arg is Error => arg instanceof Error);
    return error === undefined ? { message } : { message, errorName: error.name };
  };
  const write = (level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]): void => {
    const { message, errorName } = describe(args);
    child[level](message, errorName === undefined ? {} : { errorName });
  };
  const instance: SdkLogger = {
    debug: (...args: unknown[]) => {
      write('debug', args);
    },
    trace: (...args: unknown[]) => {
      write('debug', args);
    },
    info: (...args: unknown[]) => {
      write('info', args);
    },
    warn: (...args: unknown[]) => {
      write('warn', args);
    },
    error: (...args: unknown[]) => {
      write('error', args);
    },
    log: (level: string, ...args: unknown[]) => {
      write(
        level === 'error'
          ? 'error'
          : level === 'warn'
            ? 'warn'
            : level === 'info'
              ? 'info'
              : 'debug',
        args,
      );
    },
    child: (childName: string) => sdkLogger(logger, `${name}/${sanitizeText(childName, 40)}`),
  };
  return instance;
}

type Writable<T> = T extends readonly (infer Item)[]
  ? Writable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Writable<T[Key]> }
    : T;

/**
 * The SDK's card types are mutable; ours are read-only. Removing `readonly` is the only
 * conversion: the assignment below still checks every element against the SDK's Adaptive Card
 * types at compile time.
 */
export function toTeamsCard(card: AdaptiveCard): IAdaptiveCard {
  const writable = card as Writable<AdaptiveCard>;
  return writable;
}

export function conversationTypeOf(value: string | undefined): ConversationType {
  return value === 'personal' || value === 'groupChat' || value === 'channel' ? value : 'unknown';
}

/** Runs work after the HTTP response, tracking it for shutdown and tests. */
export class BackgroundTasks {
  readonly #running = new Set<Promise<void>>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  run(task: () => Promise<void>): void {
    const promise = task()
      .catch((error: unknown) => {
        this.#logger.error('Background task failed.', { err: error });
      })
      .finally(() => {
        this.#running.delete(promise);
      });
    this.#running.add(promise);
  }

  get size(): number {
    return this.#running.size;
  }

  async idle(): Promise<void> {
    while (this.#running.size > 0) {
      await Promise.all([...this.#running]);
    }
  }
}

/** Teams redelivers an activity it thinks timed out; each activity ID is handled once. */
export class RecentActivities {
  readonly #seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True the first time an ID is seen within the window. */
  firstTime(id: string | undefined): boolean {
    if (id === undefined || id === '') {
      return true;
    }
    const now = this.now();
    for (const [key, at] of this.#seen) {
      if (now - at <= this.ttlMs && this.#seen.size <= this.maxEntries) {
        break;
      }
      this.#seen.delete(key);
    }
    if (this.#seen.has(id)) {
      return false;
    }
    this.#seen.set(id, now);
    return true;
  }
}

/**
 * Teams single sign-on: obtains the user's token for the answer API through an Azure Bot
 * OAuth connection (SSO token exchange; a sign-in card when consent is needed). Behind an
 * interface so the rest of the bot can be tested without the Bot Framework token service.
 */
export interface SsoAdapter {
  register(
    app: App,
    callbacks: {
      readonly completed: (ctx: IActivityContext) => Promise<void>;
      readonly failed: (ctx: IActivityContext) => Promise<void>;
    },
  ): void;
  forContext(ctx: IActivityContext): TurnSignIn;
}

/** The SDK's OAuth flow for one Azure Bot OAuth connection. */
export function oauthConnectionSso(connectionName: string): SsoAdapter {
  let flow: ReturnType<App['addOAuthFlow']> | undefined;
  return {
    register: (app, callbacks) => {
      flow = app.addOAuthFlow(connectionName, {
        oauthCardText: 'Sign in to the E-Hub Knowledge Assistant with your Skin Renewal account.',
        signInButtonText: 'Sign in',
      });
      flow.onSignInComplete(async (ctx) => {
        await callbacks.completed(ctx);
      });
      flow.onSignInFailure(async (ctx) => {
        await callbacks.failed(ctx);
      });
    },
    forContext: (ctx) => ({
      token: async () => {
        if (flow === undefined) {
          return undefined;
        }
        return await flow.getToken(ctx);
      },
      start: async () => {
        if (flow !== undefined) {
          await flow.signIn(ctx);
        }
      },
    }),
  };
}

export interface TeamsBotOptions {
  readonly handler: ConversationHandler;
  readonly logger: Logger;
  readonly httpAdapter: IHttpServerAdapter;
  /** The bot's Entra app registration. Without it, only unauthenticated local tools can connect. */
  readonly credentials?: {
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly tenantId?: string;
  };
  /** Development only: accept unsigned requests (Microsoft 365 Agents Playground). */
  readonly allowUnauthenticated: boolean;
  /** Teams SSO; without it the bot can only use the development mock identity. */
  readonly sso?: SsoAdapter;
  readonly newCorrelationId?: () => string;
}

export interface TeamsBot {
  readonly app: App;
  readonly tasks: BackgroundTasks;
}

/**
 * Wires the Teams SDK to the conversation handler. All Teams-specific types stay in this
 * file. Messages are acknowledged at once (typing indicator) and answered in the background,
 * because Teams retries an activity whose HTTP response takes longer than 15 seconds and an
 * answer can take longer than that.
 */
export function createTeamsBot(options: TeamsBotOptions): TeamsBot {
  const { handler } = options;
  const logger = options.logger.child({ component: 'teams' });
  const tasks = new BackgroundTasks(logger);
  const recent = new RecentActivities();
  const newCorrelationId = options.newCorrelationId ?? generateCorrelationId;

  const app = new App({
    ...(options.credentials === undefined
      ? {}
      : {
          clientId: options.credentials.clientId,
          ...(options.credentials.clientSecret === undefined
            ? {}
            : { clientSecret: options.credentials.clientSecret }),
          ...(options.credentials.tenantId === undefined
            ? {}
            : { tenantId: options.credentials.tenantId }),
        }),
    httpServerAdapter: options.httpAdapter,
    dangerouslyAllowUnauthenticatedRequests: options.allowUnauthenticated,
    logger: sdkLogger(options.logger),
    activity: { mentions: { stripText: true } },
  });

  const turnOf = (ctx: IActivityContext): TurnInfo => ({
    correlationId: newCorrelationId(),
    conversationType: conversationTypeOf(ctx.activity.conversation.conversationType),
    conversationKey: ctx.activity.conversation.id,
    ...(options.sso === undefined ? {} : { signIn: options.sso.forContext(ctx) }),
  });

  const sinkOf = (ctx: IActivityContext): ReplySink => ({
    send: async (message: OutgoingMessage) => {
      await (message.kind === 'typing'
        ? ctx.send({ type: 'typing' })
        : ctx.send(toTeamsCard(message.card)));
    },
  });

  options.sso?.register(app, {
    completed: async (ctx) => {
      const turn = turnOf(ctx);
      const sink = sinkOf(ctx);
      // The sign-in invoke is answered by the SDK; the held question is answered afterwards.
      tasks.run(() => runWithCorrelationId(turn.correlationId, () => handler.signedIn(turn, sink)));
      await Promise.resolve();
    },
    failed: async (ctx) => {
      const turn = turnOf(ctx);
      await runWithCorrelationId(turn.correlationId, () => handler.signInFailed(turn, sinkOf(ctx)));
    },
  });

  app.on('install.add', async (ctx) => {
    const turn = turnOf(ctx);
    await runWithCorrelationId(turn.correlationId, async () => {
      logger.info('App installed.', { conversationType: turn.conversationType });
      await handler.welcome(turn, sinkOf(ctx));
    });
  });

  app.on('message', (ctx) => {
    if (!recent.firstTime(ctx.activity.id)) {
      logger.info('Duplicate activity ignored.');
      return;
    }
    const turn = turnOf(ctx);
    const sink = sinkOf(ctx);
    const text = ctx.activity.text;
    const value = ctx.activity.value as unknown;
    tasks.run(() =>
      runWithCorrelationId(turn.correlationId, async () => {
        logger.info('Message received.', {
          conversationType: turn.conversationType,
          hasValue: value !== undefined,
        });
        await handler.message({ ...turn, text, ...(value === undefined ? {} : { value }) }, sink);
      }),
    );
  });

  app.on('card.action', async (ctx) => {
    const turn = turnOf(ctx);
    const data = ctx.activity.value.action.data as unknown;
    const outcome = await runWithCorrelationId(turn.correlationId, async () => {
      const result = await handler.action({ ...turn, data });
      logger.info('Card action handled.', { followUp: result.followUp !== undefined });
      return result;
    });
    const followUp = outcome.followUp;
    if (followUp !== undefined) {
      const sink = sinkOf(ctx);
      tasks.run(() => runWithCorrelationId(turn.correlationId, () => followUp(sink)));
    }
    return {
      statusCode: 200,
      type: 'application/vnd.microsoft.activity.message',
      value: outcome.message,
    };
  });

  return { app, tasks };
}
