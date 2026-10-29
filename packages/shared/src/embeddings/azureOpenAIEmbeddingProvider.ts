import { z } from 'zod';

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
} from '../http/retry.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { SearchCredentialError, type SearchAuthenticator } from '../search/auth.js';
import { EmbeddingError, isEmbeddingError, type EmbeddingErrorCategory } from './errors.js';
import {
  countTokensUpperBound,
  embeddingCacheKey,
  hashEmbeddingInput,
  normalizeEmbeddingInput,
  type CountTokens,
} from './input.js';
import { ConcurrencyLimiter, RequestRateLimiter } from './limiters.js';
import type { EmbedOptions, Embedding, EmbeddingHealthReport, EmbeddingProvider } from './types.js';

/*
 * Azure OpenAI embeddings through the v1 REST API: POST {endpoint}/openai/v1/embeddings with the
 * deployment name as `model`. Calling REST directly keeps retries, throttling and what may be
 * logged under this code's control, as for the search client.
 */

export interface AzureOpenAIEmbeddingProviderOptions {
  /** Resource endpoint, e.g. https://contoso.openai.azure.com (an /openai/v1 suffix is accepted). */
  readonly endpoint: string;
  readonly deployment: string;
  readonly modelIdentifier: string;
  readonly embeddingVersion: string;
  readonly dimensions: number;
  /** Send `dimensions` in the request (text-embedding-3 models only). */
  readonly sendDimensions: boolean;
  readonly authenticator: SearchAuthenticator;
  readonly batchSize: number;
  readonly maxBatchTokens: number;
  readonly maxInputTokens: number;
  readonly maxConcurrency: number;
  readonly requestsPerMinute: number;
  readonly requestTimeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  readonly countTokens?: CountTokens;
  readonly fetch?: HttpFetch;
  readonly logger?: Logger;
  readonly sleep?: Sleep;
  readonly random?: RandomSource;
  readonly clock?: () => Date;
  readonly maxResponseBytes?: number;
}

export const AZURE_MAX_INPUTS_PER_REQUEST = 2048;
export const AZURE_MAX_TOKENS_PER_REQUEST = 300_000;
const HEALTH_PROBE_TEXT = 'E-Hub embedding health check.';
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()),
    }),
  ),
  model: z.string().optional(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), total_tokens: z.number().optional() })
    .optional(),
});

const silentLogger = createLogger({ service: 'embeddings', level: 'silent' });

interface PreparedInput {
  readonly normalized: string;
  readonly tokens: number;
  readonly contentHash: string;
}

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
  return `${url.origin}/openai/v1/embeddings`;
}

function categoryForStatus(status: number): EmbeddingErrorCategory {
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

async function readText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new EmbeddingError('Embedding response is too large.', { category: 'invalid_response' });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) {
    throw new EmbeddingError('Embedding response is too large.', { category: 'invalid_response' });
  }
  return text;
}

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly #url: string;
  readonly #options: AzureOpenAIEmbeddingProviderOptions;
  readonly #fetch: HttpFetch;
  readonly #logger: Logger;
  readonly #sleep: Sleep;
  readonly #random: RandomSource;
  readonly #clock: () => Date;
  readonly #countTokens: CountTokens;
  readonly #concurrency: ConcurrencyLimiter;
  readonly #rate: RequestRateLimiter;
  readonly #batchSize: number;
  readonly #maxBatchTokens: number;

  constructor(options: AzureOpenAIEmbeddingProviderOptions) {
    this.#url = normalizeEndpoint(options.endpoint);
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new RangeError('dimensions must be a positive integer.');
    }
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#logger = (options.logger ?? silentLogger).child({ component: 'embeddings' });
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#clock = options.clock ?? (() => new Date());
    this.#countTokens = options.countTokens ?? countTokensUpperBound;
    this.#concurrency = new ConcurrencyLimiter(options.maxConcurrency);
    this.#rate = new RequestRateLimiter(options.requestsPerMinute, () => Date.now(), this.#sleep);
    this.#batchSize = Math.min(options.batchSize, AZURE_MAX_INPUTS_PER_REQUEST);
    this.#maxBatchTokens = Math.min(options.maxBatchTokens, AZURE_MAX_TOKENS_PER_REQUEST);
    if (options.maxInputTokens > this.#maxBatchTokens) {
      throw new RangeError('maxInputTokens cannot exceed maxBatchTokens.');
    }
  }

  getDimensions(): number {
    return this.#options.dimensions;
  }

  getModelIdentifier(): string {
    return this.#options.modelIdentifier;
  }

  getEmbeddingVersion(): string {
    return this.#options.embeddingVersion;
  }

  async embedText(text: string, options: EmbedOptions = {}): Promise<Embedding> {
    const [embedding] = await this.embedBatch([text], options);
    if (embedding === undefined) {
      throw new EmbeddingError('No embedding was returned.', { category: 'invalid_response' });
    }
    return embedding;
  }

  async embedBatch(texts: readonly string[], options: EmbedOptions = {}): Promise<Embedding[]> {
    if (texts.length === 0) {
      return [];
    }
    const started = Date.now();
    const prepared = texts.map((text, index) => this.#prepare(text, index));

    // Identical inputs are embedded once.
    const unique = new Map<string, PreparedInput>();
    for (const input of prepared) {
      unique.set(input.contentHash, input);
    }
    const batches = this.#planBatches([...unique.values()]);
    const vectors = new Map<string, number[]>();
    let promptTokens = 0;
    await Promise.all(
      batches.map((batch) =>
        this.#concurrency.run(async () => {
          const result = await this.#requestWithRetries(batch, options.signal);
          promptTokens += result.promptTokens;
          batch.forEach((input, position) => {
            const vector = result.vectors[position];
            if (vector !== undefined) {
              vectors.set(input.contentHash, vector);
            }
          });
        }),
      ),
    );

    const generatedAt = this.#clock().toISOString();
    const embeddings = prepared.map((input): Embedding => {
      const vector = vectors.get(input.contentHash);
      if (vector === undefined) {
        throw new EmbeddingError('An embedding is missing from the response.', {
          category: 'invalid_response',
        });
      }
      return {
        vector,
        cached: false,
        metadata: {
          modelIdentifier: this.#options.modelIdentifier,
          embeddingVersion: this.#options.embeddingVersion,
          dimensions: this.#options.dimensions,
          generatedAt,
          contentHash: input.contentHash,
          cacheKey: embeddingCacheKey({
            modelIdentifier: this.#options.modelIdentifier,
            embeddingVersion: this.#options.embeddingVersion,
            dimensions: this.#options.dimensions,
            contentHash: input.contentHash,
          }),
        },
      };
    });
    // Counts only: never text or vectors.
    this.#logger.info('Embeddings generated.', {
      inputs: texts.length,
      unique: unique.size,
      requests: batches.length,
      promptTokens,
      durationMs: Date.now() - started,
    });
    return embeddings;
  }

  async healthCheck(options: EmbedOptions = {}): Promise<EmbeddingHealthReport> {
    const started = Date.now();
    const base = {
      authMode: this.#options.authenticator.mode,
      deployment: this.#options.deployment,
      modelIdentifier: this.#options.modelIdentifier,
      embeddingVersion: this.#options.embeddingVersion,
      expectedDimensions: this.#options.dimensions,
    };
    try {
      const input = this.#prepare(HEALTH_PROBE_TEXT, 0);
      const result = await this.#send([input], options.signal, { checkDimensions: false });
      const returned = result.vectors[0]?.length ?? 0;
      const problems =
        returned === this.#options.dimensions
          ? []
          : [
              `The deployment returned ${String(returned)}-dimension vectors; ${String(this.#options.dimensions)} are configured (AZURE_OPENAI_EMBEDDING_DIMENSIONS).`,
            ];
      return {
        ...base,
        status: problems.length === 0 ? 'healthy' : 'unhealthy',
        returnedDimensions: returned,
        latencyMs: Date.now() - started,
        problems,
        ...(problems.length === 0 ? {} : { failure: { category: 'dimension_mismatch' } }),
      };
    } catch (error) {
      const normalized = this.#normalizeError(error);
      return {
        ...base,
        status: 'unhealthy',
        latencyMs: Date.now() - started,
        problems: [normalized.message],
        failure: {
          category: normalized.category,
          ...(normalized.httpStatus === undefined ? {} : { httpStatus: normalized.httpStatus }),
        },
      };
    }
  }

  #prepare(text: string, index: number): PreparedInput {
    const normalized = normalizeEmbeddingInput(text);
    if (normalized === '') {
      throw new EmbeddingError(`Input ${String(index)} is empty after normalisation.`, {
        category: 'invalid_input',
        inputIndex: index,
      });
    }
    const tokens = this.#countTokens(normalized);
    if (tokens > this.#options.maxInputTokens) {
      throw new EmbeddingError(
        `Input ${String(index)} has ${String(tokens)} tokens; the limit is ${String(this.#options.maxInputTokens)}.`,
        { category: 'input_too_long', inputIndex: index },
      );
    }
    return { normalized, tokens, contentHash: hashEmbeddingInput(normalized) };
  }

  #planBatches(inputs: readonly PreparedInput[]): PreparedInput[][] {
    const batches: PreparedInput[][] = [];
    let current: PreparedInput[] = [];
    let tokens = 0;
    for (const input of inputs) {
      if (
        current.length > 0 &&
        (current.length >= this.#batchSize || tokens + input.tokens > this.#maxBatchTokens)
      ) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
      current.push(input);
      tokens += input.tokens;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  async #requestWithRetries(
    batch: readonly PreparedInput[],
    signal: AbortSignal | undefined,
  ): Promise<{ vectors: number[][]; promptTokens: number }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#rate.acquire(signal);
        return await this.#send(batch, signal, { checkDimensions: true });
      } catch (error) {
        const normalized = this.#normalizeError(error, signal);
        const delay =
          normalized.retryable && attempt < this.#options.retryPolicy.maxRetries
            ? retryDelay(attempt, this.#options.retryPolicy, normalized.retryAfterMs, this.#random)
            : undefined;
        this.#logger.warn('Embedding request failed.', {
          ...normalized.toLogFields(),
          inputs: batch.length,
          attempt: attempt + 1,
          willRetry: delay !== undefined,
        });
        if (delay === undefined) {
          throw normalized;
        }
        try {
          await this.#sleep(delay, signal);
        } catch {
          throw new EmbeddingError('Embedding request was cancelled.', { category: 'cancelled' });
        }
      }
    }
  }

  #normalizeError(error: unknown, signal?: AbortSignal): EmbeddingError {
    if (isEmbeddingError(error)) {
      return error;
    }
    if (signal?.aborted === true) {
      return new EmbeddingError('Embedding request was cancelled.', { category: 'cancelled' });
    }
    if (error instanceof SearchCredentialError) {
      return new EmbeddingError(error.message, { category: 'authentication' });
    }
    return new EmbeddingError('Embedding request failed unexpectedly.', {
      category: 'invalid_response',
    });
  }

  async #send(
    batch: readonly PreparedInput[],
    callerSignal: AbortSignal | undefined,
    checks: { readonly checkDimensions: boolean },
  ): Promise<{ vectors: number[][]; promptTokens: number }> {
    const timeout = AbortSignal.timeout(this.#options.requestTimeoutMs);
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
    const auth = await this.#options.authenticator.headers(signal);
    const body = JSON.stringify({
      model: this.#options.deployment,
      input: batch.map((input) => input.normalized),
      encoding_format: 'float',
      ...(this.#options.sendDimensions ? { dimensions: this.#options.dimensions } : {}),
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
        // Following a redirect would resend the key or token to another host.
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (callerSignal?.aborted === true) {
        throw new EmbeddingError('Embedding request was cancelled.', { category: 'cancelled' });
      }
      if (timeout.aborted) {
        throw new EmbeddingError('Embedding request timed out.', {
          category: 'timeout',
          retryable: true,
        });
      }
      const code = networkCode(error);
      throw new EmbeddingError(
        `Could not reach Azure OpenAI${code === undefined ? '' : ` (${code})`}.`,
        { category: 'network', retryable: code !== undefined && RETRYABLE_NETWORK_CODES.has(code) },
      );
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new EmbeddingError('Azure OpenAI returned an unexpected redirect.', {
        category: 'invalid_response',
        httpStatus: response.status,
      });
    }
    const text = await readText(
      response,
      this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    if (response.status !== 200) {
      // Only the status and Azure's error code: the message can quote the input.
      const serviceCode = serviceErrorCode(text);
      const retryAfterMs = parseRetryAfterHeaders(response.headers);
      throw new EmbeddingError(
        `Azure OpenAI embedding request failed with HTTP ${String(response.status)}${serviceCode === undefined ? '' : ` (${serviceCode})`}.`,
        {
          category: categoryForStatus(response.status),
          httpStatus: response.status,
          ...(serviceCode === undefined ? {} : { serviceCode }),
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      );
    }

    let parsed: z.output<typeof embeddingResponseSchema>;
    try {
      parsed = embeddingResponseSchema.parse(JSON.parse(text));
    } catch {
      throw new EmbeddingError('Azure OpenAI returned an unexpected response.', {
        category: 'invalid_response',
      });
    }
    const vectors: (number[] | undefined)[] = new Array<number[] | undefined>(batch.length);
    for (const item of parsed.data) {
      if (item.index >= batch.length || vectors[item.index] !== undefined) {
        throw new EmbeddingError('Azure OpenAI returned embeddings for unknown inputs.', {
          category: 'invalid_response',
        });
      }
      if (!item.embedding.every((value) => Number.isFinite(value))) {
        throw new EmbeddingError('Azure OpenAI returned a vector with invalid values.', {
          category: 'invalid_response',
        });
      }
      if (checks.checkDimensions && item.embedding.length !== this.#options.dimensions) {
        throw new EmbeddingError(
          `Azure OpenAI returned ${String(item.embedding.length)}-dimension vectors; ${String(this.#options.dimensions)} are configured.`,
          { category: 'dimension_mismatch' },
        );
      }
      vectors[item.index] = item.embedding;
    }
    const complete = vectors.filter((vector): vector is number[] => vector !== undefined);
    if (complete.length !== batch.length) {
      throw new EmbeddingError('Azure OpenAI returned fewer embeddings than inputs.', {
        category: 'invalid_response',
      });
    }
    return { vectors: complete, promptTokens: parsed.usage?.prompt_tokens ?? 0 };
  }
}
