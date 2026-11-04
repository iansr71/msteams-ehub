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
  type IdentityProvider,
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

function setup(options: { identity?: IdentityProvider; maxConcurrent?: number } = {}) {
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
  });
  return { handler, answers, logs };
}

const turn: TurnInfo = { correlationId: 'turn-1', conversationType: 'personal' };

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
      context: { correlationId: 'turn-1', identity: { kind: 'dev-mock', userId: 'dev-mock-user' } },
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
      await handler.message({ correlationId: 'c', conversationType, text: SECRET_QUESTION }, sink);
      expect(sink.markdown()).toContain('Personal chat only');
      const welcome = new Sink();
      await handler.welcome({ correlationId: 'c', conversationType }, welcome);
      expect(welcome.sent).toHaveLength(0);
    }
    expect(answers.asked).toHaveLength(0);
  });

  it('fails closed without an identity and never calls the API', async () => {
    const { handler, answers } = setup({ identity: noIdentityProvider });
    const sink = new Sink();
    await handler.message({ ...turn, text: SECRET_QUESTION }, sink);
    expect(sink.markdown()).toContain('Sign-in is not available yet');
    expect(sink.markdown()).not.toContain('mock identity');
    const outcome = await handler.action({
      ...turn,
      data: { ehubAction: 'feedback', answerId: 'a-1', rating: 'useful' },
    });
    expect(outcome.message).toContain('sign-in is not available');
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
      new AnswerClientError('rejected', { status: 503, code: 'authentication_not_configured' }),
      'Sign-in is not available yet',
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
