import { InMemoryTelemetry, createLogger, resetTelemetry, setTelemetry } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { answer } from '../cards/__fixtures__/answers.js';
import { AnswerClientError, HttpAnswerClient, type FetchLike } from './answerClient.js';

const credential = { kind: 'dev-mock', userId: 'dev-mock-user' } as const;

function client(handler: FetchLike, timeoutMs = 1_000) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const instance = new HttpAnswerClient({
    baseUrl: 'http://127.0.0.1:3000/',
    timeoutMs,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logs.push(line) },
    }),
    fetch: (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  });
  return { instance, calls, logs };
}

async function expectError(promise: Promise<unknown>): Promise<AnswerClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AnswerClientError);
    return error as AnswerClientError;
  }
  throw new Error('expected an error');
}

describe('HttpAnswerClient', () => {
  it('posts the question with correlation and mock identity headers and validates the answer', async () => {
    const { instance, calls } = client(() => Promise.resolve(Response.json(answer())));
    const result = await instance.ask({ question: 'Q?' }, { correlationId: 'turn-9', credential });
    expect(result.answerId).toBe('answer-123');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/v1/answers');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'x-correlation-id': 'turn-9',
      'x-ehub-mock-identity': 'dev-mock-user',
    });
    expect(calls[0]?.init.redirect).toBe('error');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ question: 'Q?' });
  });

  it('rejects responses that break the contract', async () => {
    for (const body of [{ ...answer(), extra: 1 }, { ...answer(), status: 'maybe' }, 'not json']) {
      const { instance } = client(() =>
        Promise.resolve(typeof body === 'string' ? new Response(body) : Response.json(body)),
      );
      expect(
        (await expectError(instance.ask({ question: 'Q?' }, { correlationId: 't', credential })))
          .kind,
      ).toBe('bad_response');
    }
    const big = client(() =>
      Promise.resolve(
        new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024) } }),
      ),
    );
    expect(
      (await expectError(big.instance.ask({ question: 'Q?' }, { correlationId: 't', credential })))
        .kind,
    ).toBe('bad_response');
  });

  it('classifies timeouts, outages and refusals', async () => {
    const slow = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
      30,
    );
    expect(
      (await expectError(slow.instance.ask({ question: 'Q?' }, { correlationId: 't', credential })))
        .kind,
    ).toBe('timeout');

    const refused = client(() => Promise.reject(new TypeError('fetch failed')));
    expect(
      (
        await expectError(
          refused.instance.ask({ question: 'Q?' }, { correlationId: 't', credential }),
        )
      ).kind,
    ).toBe('unavailable');

    const cases: [number, unknown, string, string | undefined][] = [
      [
        429,
        { error: { code: 'rate_limited', message: 'x' }, correlationId: 't', retryAfterMs: 2000 },
        'rejected',
        'rate_limited',
      ],
      [
        503,
        { error: { code: 'authentication_not_configured', message: 'x' }, correlationId: 't' },
        'rejected',
        'authentication_not_configured',
      ],
      [504, { error: { code: 'timeout', message: 'x' }, correlationId: 't' }, 'timeout', 'timeout'],
      [502, '<html>bad gateway</html>', 'unavailable', undefined],
      [
        403,
        { error: { code: 'no_authorized_courses', message: 'x' }, correlationId: 't' },
        'rejected',
        'no_authorized_courses',
      ],
    ];
    for (const [status, body, kind, code] of cases) {
      const { instance } = client(() =>
        Promise.resolve(
          typeof body === 'string'
            ? new Response(body, { status })
            : Response.json(body, { status }),
        ),
      );
      const error = await expectError(
        instance.ask({ question: 'Q?' }, { correlationId: 't', credential }),
      );
      expect(error.kind).toBe(kind);
      expect(error.details.code).toBe(code);
    }
  });

  it('sends feedback and logs no bodies', async () => {
    const { instance, calls, logs } = client(() =>
      Promise.resolve(Response.json({ status: 'recorded' }, { status: 202 })),
    );
    await instance.sendFeedback(
      { answerId: 'answer-123', rating: 'useful' },
      { correlationId: 'turn-2', credential },
    );
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/v1/feedback');
    await instance
      .ask({ question: 'Zebra-orchid?' }, { correlationId: 't', credential })
      .catch(() => undefined);
    expect(logs.join('\n')).not.toContain('Zebra-orchid');
  });
});

describe('trace propagation', () => {
  afterEach(() => {
    resetTelemetry();
  });

  it('sends the W3C traceparent inside an answer_api.request client span', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const { instance, calls } = client(() => Promise.resolve(Response.json(answer())));
    await instance.ask({ question: 'Q?' }, { correlationId: 'turn-9', credential });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['traceparent']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(memory.spans.map((span) => [span.name, span.kind])).toContainEqual([
      'answer_api.request',
      'client',
    ]);
  });
});
