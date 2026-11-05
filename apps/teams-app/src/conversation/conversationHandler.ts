import type { Logger } from '@ehub/shared';
import type { AnswerResponse } from '@ehub/shared/answers';

import { AnswerClientError, type AnswerClient } from '../api/answerClient.js';
import { cardActionDataSchema, type CardActionData } from '../cards/actions.js';
import { adaptiveCard, fixedText, type AdaptiveCard } from '../cards/adaptiveCard.js';
import { renderAnswerCard } from '../cards/answerCard.js';
import { renderErrorCard, renderWelcomeCard, type ErrorKind } from '../cards/statusCards.js';
import type {
  CallerCredential,
  CredentialOutcome,
  IdentityProvider,
  TurnSignIn,
} from './identity.js';

export type ConversationType = 'personal' | 'groupChat' | 'channel' | 'unknown';

export interface TurnInfo {
  /** Generated per turn and sent to the API; the card's "Reference". */
  readonly correlationId: string;
  readonly conversationType: ConversationType;
  /**
   * Routing key for this user's chat (Teams conversation ID). Used only to resume a question
   * after sign-in; never sent to the API and never treated as identity.
   */
  readonly conversationKey: string;
  /** Present when Teams single sign-on is configured. */
  readonly signIn?: TurnSignIn;
}

export type OutgoingMessage =
  { readonly kind: 'typing' } | { readonly kind: 'card'; readonly card: AdaptiveCard };

/** Where replies go; the Teams adapter implements it with the SDK's send. */
export interface ReplySink {
  send(message: OutgoingMessage): Promise<void>;
}

/** The immediate answer to a card button (a short toast in Teams), plus optional later work. */
export interface ActionOutcome {
  readonly message: string;
  /** Runs after the invoke has been answered (e.g. "Ask again" asks the question). */
  readonly followUp?: (sink: ReplySink) => Promise<void>;
}

export interface ConversationHandlerOptions {
  readonly answers: AnswerClient;
  readonly identity: IdentityProvider;
  readonly logger: Logger;
  readonly maxCardBytes: number;
  readonly allowedLinkHosts: ReadonlySet<string> | undefined;
  readonly maxConcurrentQuestions: number;
  readonly maxQuestionChars?: number;
  readonly suggestions?: readonly string[];
  readonly now?: () => number;
}

const GREETING = /^(?:hi|hello|hey|help|start|menu|\/help|\?)[\s!.]*$/i;
/** A question waiting for sign-in is kept this long. */
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1_000;
const DEFAULT_MAX_QUESTION_CHARS = 1_000;

function cleanQuestion(text: string): string {
  return text
    .normalize('NFC')
    .replace(/<at>[^<]*<\/at>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function errorKindFor(error: AnswerClientError): ErrorKind {
  switch (error.kind) {
    case 'timeout':
      return 'timeout';
    case 'unavailable':
      return 'unavailable';
    case 'bad_response':
      return 'bad_response';
    case 'rejected':
      switch (error.details.code) {
        case 'rate_limited':
          return 'rate_limited';
        case 'no_authorized_courses':
        case 'course_not_authorized':
          return 'no_access';
        case 'unauthenticated':
          return 'sign_in_failed';
        case 'forbidden':
          return 'not_permitted';
        case 'authentication_not_configured':
        case 'authentication_unavailable':
          return 'identity_unavailable';
        case 'invalid_question':
          return 'invalid_question';
        default:
          return 'bad_response';
      }
  }
}

function notice(text: string): AdaptiveCard {
  return adaptiveCard([fixedText(text)]);
}

/**
 * The conversation, independent of the Teams SDK: welcome, questions, answers, feedback. It
 * never throws to its caller; every failure becomes a card. Logs carry statuses, sizes and
 * durations, never the question or the answer. Callers run each turn inside its correlation
 * context (runWithCorrelationId), which stamps the ID on every log record.
 */
export class ConversationHandler {
  readonly #options: ConversationHandlerOptions;
  readonly #logger: Logger;
  readonly #maxQuestionChars: number;
  /** Questions asked before sign-in completed, by conversation. In memory only. */
  readonly #pending = new Map<string, { readonly question: string; readonly at: number }>();
  readonly #now: () => number;
  #inFlight = 0;

  constructor(options: ConversationHandlerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'conversation' });
    this.#maxQuestionChars = options.maxQuestionChars ?? DEFAULT_MAX_QUESTION_CHARS;
    this.#now = options.now ?? Date.now;
  }

  #remember(key: string, question: string): void {
    const now = this.#now();
    this.#pending.delete(key);
    for (const [entry, value] of this.#pending) {
      if (now - value.at > PENDING_TTL_MS || this.#pending.size >= MAX_PENDING) {
        this.#pending.delete(entry);
      }
    }
    this.#pending.set(key, { question, at: now });
  }

  #takePending(key: string): string | undefined {
    const entry = this.#pending.get(key);
    this.#pending.delete(key);
    return entry !== undefined && this.#now() - entry.at <= PENDING_TTL_MS
      ? entry.question
      : undefined;
  }

  /**
   * Token-service failures fail closed. Only the error's class name is logged: SDK HTTP errors
   * can carry request headers, including the bot's own authorization header.
   */
  async #credential(
    turn: TurnInfo,
    options: { readonly startSignIn: boolean },
  ): Promise<CredentialOutcome> {
    try {
      return await this.#options.identity.credential(turn.signIn, options);
    } catch (error) {
      this.#logger.warn('Could not obtain the user token.', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { kind: 'unavailable' };
    }
  }

  /** Teams reported sign-in complete: answer the question that was waiting, if any. */
  async signedIn(turn: TurnInfo, sink: ReplySink): Promise<void> {
    const question = this.#takePending(turn.conversationKey);
    this.#logger.info('Sign-in completed.', { resumedQuestion: question !== undefined });
    if (question === undefined) {
      await sink.send({ kind: 'card', card: notice('You are signed in. Ask me a question.') });
      return;
    }
    // No second sign-in from here: if the new token is still missing, fail rather than loop.
    await this.#ask(turn, question, sink, { startSignIn: false });
  }

  /** Teams reported that sign-in failed or was cancelled. */
  async signInFailed(turn: TurnInfo, sink: ReplySink): Promise<void> {
    this.#pending.delete(turn.conversationKey);
    this.#logger.warn('Sign-in failed.');
    await this.#error(turn, sink, 'sign_in_failed');
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  #mock(): boolean {
    return this.#options.identity.mode === 'dev-mock';
  }

  async welcome(turn: TurnInfo, sink: ReplySink): Promise<void> {
    if (turn.conversationType !== 'personal') {
      return;
    }
    await sink.send({
      kind: 'card',
      card: renderWelcomeCard({
        mockIdentity: this.#mock(),
        ...(this.#options.suggestions === undefined
          ? {}
          : { suggestions: this.#options.suggestions }),
      }),
    });
  }

  /** A message from the user: a question, a greeting, or a button posted back as a value. */
  async message(
    turn: TurnInfo & { readonly text: string; readonly value?: unknown },
    sink: ReplySink,
  ): Promise<void> {
    try {
      if (turn.conversationType !== 'personal') {
        await this.#error(turn, sink, 'personal_only');
        return;
      }
      const question = cleanQuestion(turn.text);
      if (question === '' && turn.value !== undefined) {
        const outcome = await this.action({ ...turn, data: turn.value });
        await sink.send({ kind: 'card', card: notice(outcome.message) });
        await outcome.followUp?.(sink);
        return;
      }
      if (question === '' || GREETING.test(question)) {
        await this.welcome(turn, sink);
        return;
      }
      await this.#ask(turn, question, sink);
    } catch (error) {
      this.#logger.error('Turn failed.', { err: error });
      await this.#error(turn, sink, 'bad_response').catch(() => undefined);
    }
  }

  /** A button on one of the bot's cards (Action.Execute, or Action.Submit posted back). */
  async action(turn: TurnInfo & { readonly data: unknown }): Promise<ActionOutcome> {
    const parsed = cardActionDataSchema.safeParse(turn.data);
    if (!parsed.success || turn.conversationType !== 'personal') {
      return { message: 'This button is no longer supported.' };
    }
    const data: CardActionData = parsed.data;
    if (data.ehubAction === 'retry') {
      const question = cleanQuestion(data.question);
      return {
        message: 'Asking again…',
        followUp: (sink) => this.#ask(turn, question, sink),
      };
    }
    const outcome = await this.#credential(turn, { startSignIn: false });
    if (outcome.kind !== 'credential') {
      return { message: 'Feedback could not be saved: please sign in by asking a question first.' };
    }
    try {
      await this.#options.answers.sendFeedback(
        { answerId: data.answerId, rating: data.rating },
        { correlationId: turn.correlationId, credential: outcome.credential },
      );
      this.#logger.info('Feedback sent.', { answerId: data.answerId, rating: data.rating });
      return { message: 'Thanks — your feedback was recorded.' };
    } catch (error) {
      this.#logger.warn('Feedback could not be sent.', {
        kind: error instanceof AnswerClientError ? error.kind : 'unexpected',
      });
      return { message: 'Sorry, your feedback could not be saved. Please try again later.' };
    }
  }

  async #ask(
    turn: TurnInfo,
    question: string,
    sink: ReplySink,
    options: { readonly startSignIn: boolean } = { startSignIn: true },
  ): Promise<void> {
    if (Array.from(question).length > this.#maxQuestionChars) {
      await this.#error(turn, sink, 'question_too_long');
      return;
    }
    const outcome = await this.#credential(turn, options);
    if (outcome.kind === 'sign_in_started') {
      this.#remember(turn.conversationKey, question);
      this.#logger.info('Sign-in started; question held until it completes.');
      return;
    }
    if (outcome.kind === 'unavailable') {
      await this.#error(turn, sink, 'identity_unavailable');
      return;
    }
    const credential: CallerCredential = outcome.credential;
    if (this.#inFlight >= this.#options.maxConcurrentQuestions) {
      await this.#error(turn, sink, 'busy', question);
      return;
    }
    this.#inFlight += 1;
    const started = Date.now();
    try {
      await sink.send({ kind: 'typing' });
      let response: AnswerResponse;
      try {
        response = await this.#options.answers.ask(
          { question },
          { correlationId: turn.correlationId, credential },
        );
      } catch (error) {
        const kind = error instanceof AnswerClientError ? errorKindFor(error) : 'bad_response';
        this.#logger.warn('Question not answered.', {
          errorKind: kind,
          durationMs: Date.now() - started,
        });
        await this.#error(turn, sink, kind, question);
        return;
      }
      const rendered = renderAnswerCard(response, {
        maxBytes: this.#options.maxCardBytes,
        allowedLinkHosts: this.#options.allowedLinkHosts,
        question,
      });
      await sink.send({ kind: 'card', card: rendered.card });
      this.#logger.info('Answer sent.', {
        answerId: response.answerId,
        status: response.status,
        citations: response.citations.length,
        cardBytes: rendered.bytes,
        detailLevel: rendered.detailLevel,
        durationMs: Date.now() - started,
      });
    } finally {
      this.#inFlight -= 1;
    }
  }

  async #error(turn: TurnInfo, sink: ReplySink, kind: ErrorKind, question?: string): Promise<void> {
    await sink.send({
      kind: 'card',
      card: renderErrorCard({
        kind,
        reference: turn.correlationId,
        mockIdentity: this.#mock(),
        ...(question === undefined ? {} : { question }),
      }),
    });
  }
}
