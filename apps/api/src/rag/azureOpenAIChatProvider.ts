import { createLogger, type Logger } from '@ehub/shared';
import {
  RETRYABLE_HTTP_STATUSES,
  RETRYABLE_NETWORK_CODES,
  defaultSleep,
  networkCode,
  parseRetryAfterHeaders,
  retryDelay,
  type HttpFetch,
  type RandomSource,
  type RetryPolicy,
  type Sleep,
} from '@ehub/shared/http';
import { SearchCredentialError, type SearchAuthenticator } from '@ehub/shared/search';
import { z } from 'zod';

import {
  ChatModelError,
  isChatModelError,
  type ChatCompletion,
  type ChatCompletionRequest,
  type ChatErrorCategory,
  type ChatFinishReason,
  type ChatModelProvider,
} from './chatModelProvider.js';

/*
 * Azure OpenAI chat completions through the v1 REST API: POST {endpoint}/openai/v1/chat/completions
 * with the deployment name as `model`. Structured outputs (`response_format: json_schema`,
 * `strict: true`) are used when configured.
 */

export interface AzureOpenAIChatProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly authenticator: SearchAuthenticator;
  readonly responseFormat: 'json_schema' | 'json_object';
  /** Not sent when undefined; reasoning models reject it. */
  readonly temperature: number | undefined;
  readonly requestTimeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  readonly fetch?: HttpFetch;
  readonly logger?: Logger;
  readonly sleep?: Sleep;
  readonly random?: RandomSource;
  readonly maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

const silentLogger = createLogger({ service: 'chat', level: 'silent' });

function normalizeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError('The Azure OpenAI endpoint is not a valid URL.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError('The Azure OpenAI endpoint must be an https URL without credentials.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (url.search !== '' || url.hash !== '' || (path !== '' && path !== '/openai/v1')) {
    throw new TypeError(
      'The Azure OpenAI endpoint must be the resource URL (optionally ending in /openai/v1).',
    );
  }
  return `${url.origin}/openai/v1/chat/completions`;
}

function categoryForStatus(status: number): ChatErrorCategory {
  switch (status) {
    case 401:
      return 'authentication';
    case 403:
      return 'authorization';
    case 404:
      return 'not_found';
    case 408:
      return 'timeout';
    case 429:
      return 'throttled';
    default:
      return status >= 500 ? 'unavailable' : 'invalid_request';
  }
}

function serviceErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error: unknown = parsed.error;
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code: unknown = error.code;
        if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
          return code;
        }
      }
    }
  } catch {
    // Not JSON; only the status is reported.
  }
  return undefined;
}

// A function, so the check is re-evaluated after awaits instead of narrowed once.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function finishReason(value: string | null | undefined): ChatFinishReason {
  return value === 'stop' || value === 'length' || value === 'content_filter' ? value : 'other';
}

export class AzureOpenAIChatProvider implements ChatModelProvider {
  readonly #url: string;
  readonly #options: AzureOpenAIChatProviderOptions;
  readonly #fetch: HttpFetch;
  readonly #logger: Logger;
  readonly #sleep: Sleep;
  readonly #random: RandomSource;

  constructor(options: AzureOpenAIChatProviderOptions) {
    this.#url = normalizeEndpoint(options.endpoint);
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#logger = (options.logger ?? silentLogger).child({ component: 'chat' });
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  getModelName(): string {
    return this.#options.deployment;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletion> {
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const completion = await this.#send(request);
        // Counts only: never prompt or completion text.
        this.#logger.info('Chat completion received.', {
          finishReason: completion.finishReason,
          promptTokens: completion.promptTokens,
          completionTokens: completion.completionTokens,
          attempts: attempt + 1,
          durationMs: Date.now() - started,
        });
        return completion;
      } catch (error) {
        const normalized = this.#normalize(error, request.signal);
        const delay =
          normalized.retryable && attempt < this.#options.retryPolicy.maxRetries
            ? retryDelay(attempt, this.#options.retryPolicy, normalized.retryAfterMs, this.#random)
            : undefined;
        this.#logger.warn('Chat completion failed.', {
          ...normalized.toLogFields(),
          attempt: attempt + 1,
          willRetry: delay !== undefined,
        });
        if (delay === undefined) {
          throw normalized;
        }
        try {
          await this.#sleep(delay, request.signal);
        } catch {
          throw new ChatModelError('Chat completion was cancelled.', { category: 'cancelled' });
        }
      }
    }
  }

  #normalize(error: unknown, signal: AbortSignal | undefined): ChatModelError {
    if (isChatModelError(error)) {
      return error;
    }
    if (signal?.aborted === true) {
      return new ChatModelError('Chat completion was cancelled.', { category: 'cancelled' });
    }
    if (error instanceof SearchCredentialError) {
      return new ChatModelError(error.message, { category: 'authentication' });
    }
    return new ChatModelError('Chat completion failed unexpectedly.', {
      category: 'invalid_response',
    });
  }

  #responseFormat(request: ChatCompletionRequest): Record<string, unknown> {
    if (request.responseSchema === undefined) {
      return {};
    }
    return this.#options.responseFormat === 'json_schema'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.responseSchema.name,
              strict: true,
              schema: request.responseSchema.schema,
            },
          },
        }
      : { response_format: { type: 'json_object' } };
  }

  async #send(request: ChatCompletionRequest): Promise<ChatCompletion> {
    if (isAborted(request.signal)) {
      throw new ChatModelError('Chat completion was cancelled.', { category: 'cancelled' });
    }
    const timeout = AbortSignal.timeout(this.#options.requestTimeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    const auth = await this.#options.authenticator.headers(signal);
    const body = JSON.stringify({
      model: this.#options.deployment,
      messages: request.messages,
      max_completion_tokens: request.maxOutputTokens,
      ...(this.#options.temperature === undefined
        ? {}
        : { temperature: this.#options.temperature }),
      ...this.#responseFormat(request),
    });

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'ehub-teams-assistant',
          ...auth,
        },
        body,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (isAborted(request.signal)) {
        throw new ChatModelError('Chat completion was cancelled.', { category: 'cancelled' });
      }
      if (timeout.aborted) {
        throw new ChatModelError('Chat completion timed out.', {
          category: 'timeout',
          retryable: true,
        });
      }
      const code = networkCode(error);
      throw new ChatModelError(
        `Could not reach Azure OpenAI${code === undefined ? '' : ` (${code})`}.`,
        { category: 'network', retryable: code !== undefined && RETRYABLE_NETWORK_CODES.has(code) },
      );
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ChatModelError('Azure OpenAI returned an unexpected redirect.', {
        category: 'invalid_response',
        httpStatus: response.status,
      });
    }
    const maxBytes = this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new ChatModelError('Chat completion response is too large.', {
        category: 'invalid_response',
      });
    }
    if (response.status !== 200) {
      // Only the status and error code: Azure's message can quote the prompt.
      const serviceCode = serviceErrorCode(text);
      const retryAfterMs = parseRetryAfterHeaders(response.headers);
      throw new ChatModelError(
        `Azure OpenAI chat request failed with HTTP ${String(response.status)}${serviceCode === undefined ? '' : ` (${serviceCode})`}.`,
        {
          category:
            serviceCode === 'content_filter'
              ? 'content_filter'
              : categoryForStatus(response.status),
          httpStatus: response.status,
          ...(serviceCode === undefined ? {} : { serviceCode }),
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      );
    }

    let parsed: z.output<typeof completionSchema>;
    try {
      parsed = completionSchema.parse(JSON.parse(text));
    } catch {
      throw new ChatModelError('Azure OpenAI returned an unexpected response.', {
        category: 'invalid_response',
      });
    }
    const [choice] = parsed.choices;
    if (choice === undefined) {
      throw new ChatModelError('Azure OpenAI returned no choices.', {
        category: 'invalid_response',
      });
    }
    const reason = finishReason(choice.finish_reason);
    if (reason === 'content_filter') {
      throw new ChatModelError('The response was blocked by the content filter.', {
        category: 'content_filter',
      });
    }
    return {
      // A refusal is returned as empty content and handled as malformed output by the caller.
      content: choice.message.content ?? '',
      finishReason: reason,
      model: parsed.model,
      promptTokens: parsed.usage?.prompt_tokens,
      completionTokens: parsed.usage?.completion_tokens,
    };
  }
}
