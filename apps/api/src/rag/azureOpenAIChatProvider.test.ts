import { createLogger } from '@ehub/shared';
import { apiKeyAuthenticator, tokenCredentialAuthenticator } from '@ehub/shared/search';
import { describe, expect, it, vi } from 'vitest';

import { MODEL_ANSWER_RESPONSE_SCHEMA } from './answerSchema.js';
import {
  AzureOpenAIChatProvider,
  type AzureOpenAIChatProviderOptions,
} from './azureOpenAIChatProvider.js';

const KEY = 'fake-openai-key-0123456789abcdef0123';
const PROMPT_SECRET = 'Client Jane Doe had a reaction';
const ANSWER_SECRET = 'Advise the client to stop treatment';

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeService(
  responses: { status: number; body?: unknown; headers?: Record<string, string> }[],
) {
  const requests: Recorded[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      url,
      headers,
      body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    });
    const next = responses.shift() ?? {
      status: 200,
      body: {
        model: 'gpt-4o',
        choices: [{ finish_reason: 'stop', message: { content: ANSWER_SECRET } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    };
    return Promise.resolve(
      new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers ?? {},
      }),
    );
  };
  return { requests, fetch };
}

function provider(
  fetch: AzureOpenAIChatProviderOptions['fetch'],
  overrides: Partial<AzureOpenAIChatProviderOptions> = {},
) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const instance = new AzureOpenAIChatProvider({
    endpoint: 'https://contoso.openai.azure.com',
    deployment: 'chat-deployment',
    authenticator: apiKeyAuthenticator(KEY),
    responseFormat: 'json_schema',
    temperature: undefined,
    requestTimeoutMs: 5_000,
    retryPolicy: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000, maxRetryAfterMs: 10_000 },
    ...(fetch === undefined ? {} : { fetch }),
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logs.push(line) },
    }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...overrides,
  });
  return { instance, logs, sleeps };
}

const request = {
  messages: [
    { role: 'system' as const, content: 'rules' },
    { role: 'user' as const, content: PROMPT_SECRET },
  ],
  responseSchema: MODEL_ANSWER_RESPONSE_SCHEMA,
  maxOutputTokens: 800,
};

describe('AzureOpenAIChatProvider', () => {
  it('posts to the v1 chat endpoint with structured outputs and no temperature by default', async () => {
    const service = fakeService([]);
    const { instance } = provider(service.fetch);
    const completion = await instance.complete(request);
    expect(completion).toMatchObject({
      content: ANSWER_SECRET,
      finishReason: 'stop',
      model: 'gpt-4o',
      promptTokens: 10,
    });
    const sent = service.requests[0];
    expect(sent?.url).toBe('https://contoso.openai.azure.com/openai/v1/chat/completions');
    expect(sent?.headers['api-key']).toBe(KEY);
    expect(sent?.body).toEqual({
      model: 'chat-deployment',
      messages: request.messages,
      max_completion_tokens: 800,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ehub_grounded_answer',
          strict: true,
          schema: MODEL_ANSWER_RESPONSE_SCHEMA.schema,
        },
      },
    });
  });

  it('uses json_object mode and sends temperature when configured', async () => {
    const service = fakeService([]);
    await provider(service.fetch, {
      responseFormat: 'json_object',
      temperature: 0,
    }).instance.complete(request);
    expect(service.requests[0]?.body).toMatchObject({
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  });

  it('retries throttling and server errors, honouring Retry-After', async () => {
    const service = fakeService([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 503 },
    ]);
    const { instance, sleeps } = provider(service.fetch);
    await instance.complete(request);
    expect(service.requests).toHaveLength(3);
    expect(sleeps).toEqual([2000, 100]);
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not_found'],
  ])('does not retry HTTP %i', async (status, category) => {
    const service = fakeService([
      { status, body: { error: { code: 'Some_Code', message: `Echo: ${PROMPT_SECRET}` } } },
    ]);
    const failure = await provider(service.fetch)
      .instance.complete(request)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ category, httpStatus: status, serviceCode: 'Some_Code' });
    expect((failure as Error).message).not.toContain(PROMPT_SECRET);
    expect(service.requests).toHaveLength(1);
  });

  it('reports content filtering on the request or the completion', async () => {
    const blockedPrompt = fakeService([
      { status: 400, body: { error: { code: 'content_filter', message: 'x' } } },
    ]);
    await expect(provider(blockedPrompt.fetch).instance.complete(request)).rejects.toMatchObject({
      category: 'content_filter',
    });
    const blockedAnswer = fakeService([
      {
        status: 200,
        body: { choices: [{ finish_reason: 'content_filter', message: { content: null } }] },
      },
    ]);
    await expect(provider(blockedAnswer.fetch).instance.complete(request)).rejects.toMatchObject({
      category: 'content_filter',
    });
  });

  it('reports truncation and rejects malformed responses', async () => {
    const truncated = fakeService([
      {
        status: 200,
        body: { choices: [{ finish_reason: 'length', message: { content: '{"a' } }] },
      },
    ]);
    expect((await provider(truncated.fetch).instance.complete(request)).finishReason).toBe(
      'length',
    );
    for (const body of [{ choices: [] }, { nope: true }]) {
      const malformed = fakeService([{ status: 200, body }]);
      await expect(provider(malformed.fetch).instance.complete(request)).rejects.toMatchObject({
        category: 'invalid_response',
      });
    }
  });

  it('times out and supports cancellation', async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted === true) {
            reject(new DOMException('aborted', 'AbortError'));
          }
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    await expect(
      provider(hanging, {
        requestTimeoutMs: 20,
        retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
      }).instance.complete(request),
    ).rejects.toMatchObject({ category: 'timeout' });
    const controller = new AbortController();
    const pending = provider(hanging).instance.complete({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: 'cancelled' });
  });

  it('does not follow redirects and never logs prompts, completions or the key', async () => {
    const service = fakeService([{ status: 503 }]);
    const redirects: unknown[] = [];
    const { instance, logs } = provider((url, init) => {
      redirects.push(init.redirect);
      return service.fetch(url, init);
    });
    await instance.complete(request);
    expect(redirects).toEqual(['manual', 'manual']);
    const text = logs.join('\n');
    expect(text).not.toContain(PROMPT_SECRET);
    expect(text).not.toContain(ANSWER_SECRET);
    expect(text).not.toContain(KEY);
    expect(text).toContain('Chat completion received.');
  });

  it('authenticates with Entra ID tokens for the configured scope', async () => {
    const getToken = vi.fn(() =>
      Promise.resolve({ token: 'entra-chat-token', expiresOnTimestamp: 0 }),
    );
    const service = fakeService([]);
    await provider(service.fetch, {
      authenticator: tokenCredentialAuthenticator({ getToken }, 'https://ai.azure.com/.default'),
    }).instance.complete(request);
    expect(service.requests[0]?.headers['authorization']).toBe('Bearer entra-chat-token');
    expect(getToken).toHaveBeenCalledWith('https://ai.azure.com/.default', expect.anything());
  });
});
