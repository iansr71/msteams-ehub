import { createLogger } from '@ehub/shared';
import type { AnswerRequest, AnswerResponse, FeedbackRequest } from '@ehub/shared/answers';
import { describe, expect, it } from 'vitest';

import { AnswerClientError, type AnswerClient, type RequestContext } from '../api/answerClient.js';
import { actions, answer, texts } from '../cards/__fixtures__/answers.js';
import type { AdaptiveCard } from '../cards/adaptiveCard.js';
import {
  ConversationHandler,
  type OutgoingMessage,
  type ReplySink,
  type TurnInfo,
} from './conversationHandler.js';
import {
  MockIdentityProvider,
  MockIdentityRefusedError,
  noIdentityProvider,
  ssoIdentityProvider,
  type IdentityProvider,
  type TurnSignIn,
} from './identity.js';

const SECRET_QUESTION = 'Zebra-orchid question about peel aftercare?';

class FakeAnswers implements AnswerClient {
  readonly asked: { request: AnswerRequest; context: RequestContext }[] = [];
  readonly feedback: { request: FeedbackRequest; context: RequestContext }[] = [];
  next: () => Promise<AnswerResponse> = () => Promise.resolve(answer());
  feedbackResult: () => Promise<void> = () => Promise.resolve();

  ask(request: AnswerRequest, context: RequestContext): Promise<AnswerResponse> {
    this.asked.push({ request, context });
    return this.next();
  }

  sendFeedback(request: FeedbackRequest, context: RequestContext): Promise<void> {
    this.feedback.push({ request, context });
    return this.feedbackResult();
  }
}

class Sink implements ReplySink {
  readonly sent: OutgoingMessage[] = [];
  send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  cards(): AdaptiveCard[] {
    return this.sent.flatMap((message) => (message.kind === 'card' ? [message.card] : []));
  }
  markdown(): string {
    return this.cards()
      .flatMap((card) => texts(card).markdown)
      .join('\n');
  }
}

/** Teams SSO as the bot sees it: a token once signed in, otherwise a sign-in to start. */
class FakeSignIn implements TurnSignIn {
  current: string | undefined;
  starts = 0;
  constructor(token?: string) {
    this.current = token;
  }
  token(): Promise<string | undefined> {
    return Promise.resolve(this.current);
  }
  start(): Promise<void> {
    this.starts += 1;
    return Promise.resolve();
  }
}

function setup(
  options: { identity?: IdentityProvider; maxConcurrent?: number; now?: () => number } = {},
) {
  const answers = new FakeAnswers();
  const logs: string[] = [];
  const handler = new ConversationHandler({
    answers,
    identity:
      options.identity ??
      new MockIdentityProvider({ nodeEnv: 'development', userId: 'dev-mock-user' }),
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logs.push(line) },
    }),
    maxCardBytes: 24_000,
    allowedLinkHosts: undefined,
    maxConcurrentQuestions: options.maxConcurrent ?? 4,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { handler, answers, logs };
}

const turn: TurnInfo = {
  correlationId: 'turn-1',
  conversationType: 'personal',
  conversationKey: 'conv-1',
};

describe('conversation handler', () => {
  it('welcomes on install and on greetings, with the mock identity marked', async () => {
    const { handler, answers } = setup();
    for (const text of ['hi', 'Hello!', 'help', '  ', '?']) {
      const sink = new Sink();
      await handler.message({ ...turn, text }, sink);
      expect(sink.markdown()).toContain('E-Hub Knowledge Assistant');
      expect(sink.markdown()).toContain('mock identity');
    }
    const sink = new Sink();
    await handler.welcome(turn, sink);
    expect(sink.cards()).toHaveLength(1);
    expect(answers.asked).toHaveLength(0);
  });

  it('asks the API with the correlation ID and mock identity, then renders the answer', async () => {
    const { handler, answers, logs } = setup();
    const sink = new Sink();
    await handler.message({ ...turn, text: `  ${SECRET_QUESTION}  ` }, sink);
    expect(sink.sent[0]).toEqual({ kind: 'typing' });
    expect(answers.asked[0]).toEqual({
      request: { question: SECRET_QUESTION },
      context: {
        correlationId: 'turn-1',
        credential: { kind: 'dev-mock', userId: 'dev-mock-user' },
      },
    });
    expect(sink.markdown()).toContain('Sources');
    expect(handler.inFlight).toBe(0);
    const log = logs.join('\n');
    expect(log).toContain('"answerId":"answer-123"');
    expect(log).not.toContain('Zebra-orchid');
    expect(log).not.toContain('Reapply SPF');
  });

  it('refuses group chats and channels', async () => {
    const { handler, answers } = setup();
    for (const conversationType of ['groupChat', 'channel', 'unknown'] as const) {
      const sink = new Sink();
      await handler.message(
        { correlationId: 'c', conversationType, conversationKey: 'c', text: SECRET_QUESTION },
        sink,
      );
      expect(sink.markdown()).toContain('Personal chat only');
      const welcome = new Sink();
      await handler.welcome(
        { correlationId: 'c', conversationType, conversationKey: 'c' },
        welcome,
      );
      expect(welcome.sent).toHaveLength(0);
    }
    expect(answers.asked).toHaveLength(0);
  });

  it('fails closed without an identity and never calls the API', async () => {
    const { handler, answers } = setup({ identity: noIdentityProvider });
    const sink = new Sink();
    await handler.message({ ...turn, text: SECRET_QUESTION }, sink);
    expect(sink.markdown()).toContain('Sign-in is not available');
    expect(sink.markdown()).not.toContain('mock identity');
    const outcome = await handler.action({
      ...turn,
      data: { ehubAction: 'feedback', answerId: 'a-1', rating: 'useful' },
    });
    expect(outcome.message).toContain('please sign in by asking a question first');
    expect(answers.asked).toHaveLength(0);
    expect(answers.feedback).toHaveLength(0);
  });

  it('refuses the mock identity outside development', () => {
    expect(
      () => new MockIdentityProvider({ nodeEnv: 'production', userId: 'dev-mock-user' }),
    ).toThrow(MockIdentityRefusedError);
    expect(() => new MockIdentityProvider({ nodeEnv: 'test', userId: 'dev-mock-user' })).toThrow(
      MockIdentityRefusedError,
    );
    expect(
      () => new MockIdentityProvider({ nodeEnv: 'development', userId: 'someone@example.com' }),
    ).toThrow(MockIdentityRefusedError);
  });

  it('rejects over-long questions without calling the API', async () => {
    const { handler, answers } = setup();
    const sink = new Sink();
    await handler.message({ ...turn, text: 'x'.repeat(1_001) }, sink);
    expect(sink.markdown()).toContain('Question too long');
    expect(answers.asked).toHaveLength(0);
  });

  it.each([
    [new AnswerClientError('timeout'), 'That took too long', true],
    [new AnswerClientError('unavailable', { status: 502 }), 'Answers are unavailable', true],
    [new AnswerClientError('bad_response'), 'Something went wrong', true],
    [
      new AnswerClientError('rejected', { status: 429, code: 'rate_limited' }),
      'Too many questions',
      true,
    ],
    [
      new AnswerClientError('rejected', { status: 403, code: 'no_authorized_courses' }),
      'No E-Hub access found',
      false,
    ],
    [
      new AnswerClientError('rejected', { status: 403, code: 'identity_not_mapped' }),
      'Your account is not linked to E-Hub',
      false,
    ],
    [
      new AnswerClientError('rejected', { status: 503, code: 'authorization_unavailable' }),
      'Course access cannot be checked',
      true,
    ],
    [
      new AnswerClientError('rejected', { status: 503, code: 'authentication_not_configured' }),
      'Sign-in is not available',
      false,
    ],
    [new Error('boom'), 'Something went wrong', true],
  ] as const)('turns %s into a useful error card', async (error, title, retry) => {
    const { handler, answers } = setup();
    answers.next = () => Promise.reject(error);
    const sink = new Sink();
    await handler.message({ ...turn, text: SECRET_QUESTION }, sink);
    expect(sink.markdown()).toContain(title);
    expect(sink.markdown()).toContain('Reference: turn-1');
    const retryButtons = sink
      .cards()
      .flatMap(actions)
      .filter((action) => action.type === 'Action.Execute');
    expect(retryButtons.length).toBe(retry ? 1 : 0);
    expect(handler.inFlight).toBe(0);
  });

  it('tells the user when too many questions are in flight', async () => {
    const { handler, answers } = setup({ maxConcurrent: 1 });
    let release: () => void = () => undefined;
    answers.next = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(answer());
        };
      });
    const first = handler.message({ ...turn, text: 'first question?' }, new Sink());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sink = new Sink();
    await handler.message({ ...turn, text: 'second question?' }, sink);
    expect(sink.markdown()).toContain('Busy right now');
    release();
    await first;
    expect(answers.asked).toHaveLength(1);
  });

  it('records feedback and answers the button quickly', async () => {
    const { handler, answers } = setup();
    const outcome = await handler.action({
      ...turn,
      data: { ehubAction: 'feedback', answerId: 'answer-123', rating: 'not_useful' },
    });
    expect(outcome.message).toBe('Thanks — your feedback was recorded.');
    expect(answers.feedback[0]?.request).toEqual({ answerId: 'answer-123', rating: 'not_useful' });
    answers.feedbackResult = () => Promise.reject(new AnswerClientError('timeout'));
    expect(
      (
        await handler.action({
          ...turn,
          data: { ehubAction: 'feedback', answerId: 'a', rating: 'useful' },
        })
      ).message,
    ).toContain('could not be saved');
  });

  it('validates button data as untrusted input', async () => {
    const { handler, answers } = setup();
    for (const data of [
      undefined,
      'x',
      { ehubAction: 'delete-everything' },
      { ehubAction: 'feedback', answerId: 'bad id', rating: 'useful' },
      { ehubAction: 'feedback', answerId: 'a', rating: 'love' },
    ]) {
      expect((await handler.action({ ...turn, data })).message).toBe(
        'This button is no longer supported.',
      );
    }
    expect(
      (
        await handler.action({
          correlationId: 'c',
          conversationType: 'channel',
          conversationKey: 'c',
          data: { ehubAction: 'feedback', answerId: 'a', rating: 'useful' },
        })
      ).message,
    ).toBe('This button is no longer supported.');
    expect(answers.feedback).toHaveLength(0);
  });

  it('asks again from the retry button as a follow-up', async () => {
    const { handler, answers } = setup();
    const outcome = await handler.action({
      ...turn,
      data: { ehubAction: 'retry', question: SECRET_QUESTION },
    });
    expect(outcome.message).toBe('Asking again…');
    expect(answers.asked).toHaveLength(0);
    const sink = new Sink();
    await outcome.followUp?.(sink);
    expect(answers.asked[0]?.request.question).toBe(SECRET_QUESTION);
    expect(sink.markdown()).toContain('Sources');
  });

  it('handles buttons posted back as message values by older clients', async () => {
    const { handler, answers } = setup();
    const sink = new Sink();
    await handler.message(
      {
        ...turn,
        text: '',
        value: { ehubAction: 'feedback', answerId: 'answer-123', rating: 'useful' },
      },
      sink,
    );
    expect(answers.feedback).toHaveLength(1);
    expect(sink.markdown()).toContain('Thanks');
  });
});

describe('conversation handler with Teams single sign-on', () => {
  const USER_TOKEN = 'eyJ.header-payload.signature-not-for-logs';

  it('forwards the SSO token as an opaque credential and never logs it', async () => {
    const { handler, answers, logs } = setup({ identity: ssoIdentityProvider });
    const signIn = new FakeSignIn(USER_TOKEN);
    const sink = new Sink();
    await handler.message({ ...turn, signIn, text: SECRET_QUESTION }, sink);
    expect(answers.asked[0]?.context).toEqual({
      correlationId: 'turn-1',
      credential: { kind: 'user-token', token: USER_TOKEN },
    });
    expect(signIn.starts).toBe(0);
    expect(sink.markdown()).toContain('Sources');
    expect(sink.markdown()).not.toContain('mock identity');
    expect(logs.join('\n')).not.toContain('signature-not-for-logs');
  });

  it('starts sign-in, holds the question, and answers it once sign-in completes', async () => {
    const { handler, answers, logs } = setup({ identity: ssoIdentityProvider });
    const signIn = new FakeSignIn();
    const first = new Sink();
    await handler.message({ ...turn, signIn, text: SECRET_QUESTION }, first);
    expect(signIn.starts).toBe(1);
    expect(answers.asked).toHaveLength(0);
    expect(first.cards()).toHaveLength(0);

    signIn.current = USER_TOKEN;
    const resumed = new Sink();
    await handler.signedIn({ ...turn, signIn }, resumed);
    expect(answers.asked).toHaveLength(1);
    expect(answers.asked[0]?.request.question).toBe(SECRET_QUESTION);
    expect(resumed.markdown()).toContain('Sources');
    expect(logs.join('\n')).not.toContain('Zebra-orchid');

    // The held question is used once.
    const again = new Sink();
    await handler.signedIn({ ...turn, signIn }, again);
    expect(answers.asked).toHaveLength(1);
    expect(again.markdown()).toContain('You are signed in');
  });

  it('keeps held questions per conversation', async () => {
    const { handler, answers } = setup({ identity: ssoIdentityProvider });
    const signIn = new FakeSignIn();
    await handler.message(
      { ...turn, conversationKey: 'a', signIn, text: 'question A?' },
      new Sink(),
    );
    await handler.message(
      { ...turn, conversationKey: 'b', signIn, text: 'question B?' },
      new Sink(),
    );
    signIn.current = USER_TOKEN;
    await handler.signedIn({ ...turn, conversationKey: 'b', signIn }, new Sink());
    expect(answers.asked.map((entry) => entry.request.question)).toEqual(['question B?']);
  });

  it('does not start a second sign-in when the token is still missing after completion', async () => {
    const { handler, answers } = setup({ identity: ssoIdentityProvider });
    const signIn = new FakeSignIn();
    await handler.message({ ...turn, signIn, text: SECRET_QUESTION }, new Sink());
    const sink = new Sink();
    await handler.signedIn({ ...turn, signIn }, sink);
    expect(signIn.starts).toBe(1);
    expect(answers.asked).toHaveLength(0);
    expect(sink.markdown()).toContain('Sign-in is not available');
  });

  it('drops held questions older than ten minutes', async () => {
    let clock = 1_000_000;
    const { handler, answers } = setup({ identity: ssoIdentityProvider, now: () => clock });
    const signIn = new FakeSignIn();
    await handler.message({ ...turn, signIn, text: SECRET_QUESTION }, new Sink());
    clock += 10 * 60_000 + 1;
    signIn.current = USER_TOKEN;
    const sink = new Sink();
    await handler.signedIn({ ...turn, signIn }, sink);
    expect(answers.asked).toHaveLength(0);
    expect(sink.markdown()).toContain('You are signed in');
  });

  it('holds at most 1000 questions, dropping the oldest first', async () => {
    const { handler, answers } = setup({ identity: ssoIdentityProvider });
    const signIn = new FakeSignIn();
    for (let index = 0; index <= 1_000; index += 1) {
      await handler.message(
        {
          ...turn,
          conversationKey: `c-${String(index)}`,
          signIn,
          text: `question ${String(index)}?`,
        },
        new Sink(),
      );
    }
    signIn.current = USER_TOKEN;
    await handler.signedIn({ ...turn, conversationKey: 'c-0', signIn }, new Sink());
    await handler.signedIn({ ...turn, conversationKey: 'c-1', signIn }, new Sink());
    await handler.signedIn({ ...turn, conversationKey: 'c-1000', signIn }, new Sink());
    expect(answers.asked.map((entry) => entry.request.question)).toEqual([
      'question 1?',
      'question 1000?',
    ]);
  });

  it('reports a failed sign-in and forgets the held question', async () => {
    const { handler, answers } = setup({ identity: ssoIdentityProvider });
    const signIn = new FakeSignIn();
    await handler.message({ ...turn, signIn, text: SECRET_QUESTION }, new Sink());
    const failed = new Sink();
    await handler.signInFailed({ ...turn, signIn }, failed);
    expect(failed.markdown()).toContain('Sign-in did not work');
    signIn.current = USER_TOKEN;
    await handler.signedIn({ ...turn, signIn }, new Sink());
    expect(answers.asked).toHaveLength(0);
  });

  it('fails closed, without logging the error, when the token service fails', async () => {
    const { handler, answers, logs } = setup({ identity: ssoIdentityProvider });
    const broken: TurnSignIn = {
      token: () => Promise.reject(new TypeError('Authorization: Bearer bot-secret-token')),
      start: () => Promise.resolve(),
    };
    const sink = new Sink();
    await handler.message({ ...turn, signIn: broken, text: SECRET_QUESTION }, sink);
    expect(answers.asked).toHaveLength(0);
    expect(sink.markdown()).toContain('Sign-in is not available');
    expect(logs.join('\n')).toContain('"errorType":"TypeError"');
    expect(logs.join('\n')).not.toContain('bot-secret-token');
  });

  it('fails closed when the Teams turn has no sign-in support', async () => {
    const { handler, answers } = setup({ identity: ssoIdentityProvider });
    const sink = new Sink();
    await handler.message({ ...turn, text: SECRET_QUESTION }, sink);
    expect(answers.asked).toHaveLength(0);
    expect(sink.markdown()).toContain('Sign-in is not available');
  });

  it('records feedback with an existing token but never starts sign-in from a button', async () => {
    const { handler, answers } = setup({ identity: ssoIdentityProvider });
    const signedOut = new FakeSignIn();
    const refused = await handler.action({
      ...turn,
      signIn: signedOut,
      data: { ehubAction: 'feedback', answerId: 'a-1', rating: 'useful' },
    });
    expect(refused.message).toContain('please sign in by asking a question first');
    expect(signedOut.starts).toBe(0);
    const signedIn = new FakeSignIn(USER_TOKEN);
    await handler.action({
      ...turn,
      signIn: signedIn,
      data: { ehubAction: 'feedback', answerId: 'a-1', rating: 'useful' },
    });
    expect(answers.feedback[0]?.context.credential).toEqual({
      kind: 'user-token',
      token: USER_TOKEN,
    });
  });

  it.each([
    [401, 'unauthenticated', 'Sign-in did not work', true],
    [403, 'forbidden', 'Not available for your account', false],
    [503, 'authentication_unavailable', 'Sign-in is not available', false],
  ] as const)('maps API %s %s to a clear card', async (status, code, title, retry) => {
    const { handler, answers } = setup({ identity: ssoIdentityProvider });
    answers.next = () => Promise.reject(new AnswerClientError('rejected', { status, code }));
    const sink = new Sink();
    await handler.message(
      { ...turn, signIn: new FakeSignIn(USER_TOKEN), text: SECRET_QUESTION },
      sink,
    );
    expect(sink.markdown()).toContain(title);
    const retryButtons = sink
      .cards()
      .flatMap(actions)
      .filter((action) => action.type === 'Action.Execute');
    expect(retryButtons.length).toBe(retry ? 1 : 0);
  });
});
