import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logging/logger.js';
import { clearRegisteredSecretValues } from '../logging/redaction.js';
import { apiKeyAuthenticator, tokenCredentialAuthenticator } from '../search/auth.js';
import { FakeEmbeddingService, fakeVector } from './__fixtures__/fakeEmbeddingService.js';
import {
  AzureOpenAIEmbeddingProvider,
  type AzureOpenAIEmbeddingProviderOptions,
} from './azureOpenAIEmbeddingProvider.js';
import { FileEmbeddingCache, InMemoryEmbeddingCache } from './cache.js';
import { CachingEmbeddingProvider } from './cachingEmbeddingProvider.js';
import { EmbeddingError } from './errors.js';
import { createEmbeddingProvider, type EmbeddingSettings } from './factory.js';
import { embeddingCacheKey, hashEmbeddingInput, normalizeEmbeddingInput } from './input.js';
import { ConcurrencyLimiter, RequestRateLimiter } from './limiters.js';

const API_KEY = 'fake-openai-key-0123456789abcdef0123';
const DIMENSIONS = 8;
const SECRET_TEXT = 'Client Jane Doe reacted to the peel on 3 March';

const tempDirectory = mkdtempSync(join(tmpdir(), 'ehub-embedding-cache-'));

afterEach(() => {
  clearRegisteredSecretValues();
});

afterAll(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

function setup(overrides: Partial<AzureOpenAIEmbeddingProviderOptions> = {}) {
  const service = new FakeEmbeddingService({ apiKey: API_KEY, dimensions: DIMENSIONS });
  const logLines: string[] = [];
  // Retry back-off waits only; the rate limiter's sub-millisecond spacing is left out.
  const sleeps: number[] = [];
  const provider = new AzureOpenAIEmbeddingProvider({
    endpoint: 'https://contoso.openai.azure.com',
    deployment: 'embed-deployment',
    modelIdentifier: 'text-embedding-3-small',
    embeddingVersion: '1',
    dimensions: DIMENSIONS,
    sendDimensions: false,
    authenticator: apiKeyAuthenticator(API_KEY),
    batchSize: 64,
    maxBatchTokens: 100_000,
    maxInputTokens: 8_191,
    maxConcurrency: 2,
    requestsPerMinute: 60_000,
    requestTimeoutMs: 5_000,
    retryPolicy: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1_000, maxRetryAfterMs: 10_000 },
    fetch: service.fetch,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logLines.push(line) },
    }),
    sleep: (ms) => {
      if (ms >= 2) {
        sleeps.push(ms);
      }
      return Promise.resolve();
    },
    random: () => 0.5,
    clock: () => new Date('2026-10-29T10:00:00.000Z'),
    ...overrides,
  });
  return { service, provider, logLines, sleeps };
}

describe('embedding input', () => {
  it('normalises Unicode, invisible characters and whitespace', () => {
    expect(normalizeEmbeddingInput('  Café\u200b  peel\u0000\n\tcare\u202e ')).toBe(
      'Café peel care',
    );
    expect(normalizeEmbeddingInput(' \u200b\n\t ')).toBe('');
  });

  it('builds cache keys that change with model, version, dimensions and content', () => {
    const base = {
      modelIdentifier: 'text-embedding-3-small',
      embeddingVersion: '1',
      dimensions: 1536,
      contentHash: hashEmbeddingInput('peel'),
    };
    const key = embeddingCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(embeddingCacheKey(base)).toBe(key);
    for (const change of [
      { modelIdentifier: 'text-embedding-3-large' },
      { embeddingVersion: '2' },
      { dimensions: 3072 },
      { contentHash: hashEmbeddingInput('peels') },
    ]) {
      expect(embeddingCacheKey({ ...base, ...change })).not.toBe(key);
    }
  });
});

describe('AzureOpenAIEmbeddingProvider', () => {
  it('posts to the v1 endpoint with the deployment as model and attaches metadata', async () => {
    const { service, provider } = setup();
    const [first, second] = await provider.embedBatch(['Peel aftercare', ' Peel   aftercare ']);
    expect(service.requests).toHaveLength(1);
    const request = service.requests[0];
    expect(request?.url).toBe('https://contoso.openai.azure.com/openai/v1/embeddings');
    expect(request?.headers['api-key']).toBe(API_KEY);
    // Identical normalised inputs are embedded once.
    expect(request?.body).toEqual({
      model: 'embed-deployment',
      input: ['Peel aftercare'],
      encoding_format: 'float',
    });
    expect(first?.vector).toEqual(fakeVector('Peel aftercare', DIMENSIONS));
    expect(second?.vector).toEqual(first?.vector);
    expect(first?.metadata).toEqual({
      modelIdentifier: 'text-embedding-3-small',
      embeddingVersion: '1',
      dimensions: DIMENSIONS,
      generatedAt: '2026-10-29T10:00:00.000Z',
      contentHash: hashEmbeddingInput('Peel aftercare'),
      cacheKey: embeddingCacheKey({
        modelIdentifier: 'text-embedding-3-small',
        embeddingVersion: '1',
        dimensions: DIMENSIONS,
        contentHash: hashEmbeddingInput('Peel aftercare'),
      }),
    });
    expect(provider.getDimensions()).toBe(DIMENSIONS);
    expect(provider.getModelIdentifier()).toBe('text-embedding-3-small');
  });

  it('accepts an endpoint that already ends in /openai/v1 and rejects others', () => {
    expect(() => setup({ endpoint: 'https://contoso.openai.azure.com/openai/v1/' })).not.toThrow();
    for (const endpoint of [
      'http://contoso.openai.azure.com',
      'https://contoso.openai.azure.com/other',
      'https://k:p@x.test',
    ]) {
      expect(() => setup({ endpoint })).toThrow(TypeError);
    }
  });

  it('sends dimensions only when configured', async () => {
    const { service, provider } = setup({ sendDimensions: true });
    await provider.embedText('peel');
    expect(service.requests[0]?.body.dimensions).toBe(DIMENSIONS);
  });

  it('rejects empty and over-long input before any request', async () => {
    const { service, provider } = setup({ maxInputTokens: 10 });
    await expect(provider.embedBatch(['ok', ' \u200b '])).rejects.toMatchObject({
      category: 'invalid_input',
      inputIndex: 1,
    });
    await expect(provider.embedText('x'.repeat(11))).rejects.toMatchObject({
      category: 'input_too_long',
    });
    expect(service.requests).toHaveLength(0);
  });

  it('uses an injected token counter for the input limit', async () => {
    const { provider } = setup({
      maxInputTokens: 3,
      countTokens: (text) => text.split(' ').length,
    });
    await expect(provider.embedText('one two three')).resolves.toBeDefined();
    await expect(provider.embedText('one two three four')).rejects.toMatchObject({
      category: 'input_too_long',
    });
  });

  it('batches by input count and by token total, preserving order', async () => {
    const { service, provider } = setup({ batchSize: 2, maxBatchTokens: 20, maxInputTokens: 20 });
    const texts = ['aaaa', 'bbbb', 'cccc', 'dddddddddddddddd', 'eeee'];
    const embeddings = await provider.embedBatch(texts);
    expect(embeddings.map((embedding) => embedding.vector)).toEqual(
      texts.map((text) => fakeVector(text, DIMENSIONS)),
    );
    expect(service.requests.map((request) => request.body.input)).toEqual([
      ['aaaa', 'bbbb'],
      ['cccc', 'dddddddddddddddd'],
      ['eeee'],
    ]);
  });

  it('limits concurrent requests', async () => {
    const { service, provider } = setup({ batchSize: 1, maxConcurrency: 2 });
    service.latencyMs = 20;
    await provider.embedBatch(['a1', 'b2', 'c3', 'd4', 'e5']);
    expect(service.requests).toHaveLength(5);
    expect(service.maxObservedConcurrency).toBe(2);
  });

  it('retries throttling and server errors with backoff, honouring Retry-After', async () => {
    const { service, provider, sleeps } = setup();
    service.scripted.push(
      { status: 429, headers: { 'retry-after-ms': '1500' } },
      { status: 503 },
      { status: 500 },
    );
    await expect(provider.embedText('peel')).resolves.toBeDefined();
    expect(service.requests).toHaveLength(4);
    expect(sleeps).toEqual([1500, 100, 200]);
  });

  it('gives up after the retry budget', async () => {
    const { service, provider } = setup();
    for (let i = 0; i < 4; i += 1) {
      service.scripted.push({ status: 503 });
    }
    await expect(provider.embedText('peel')).rejects.toMatchObject({
      category: 'unavailable',
      httpStatus: 503,
    });
    expect(service.requests).toHaveLength(4);
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not_found'],
  ])('does not retry HTTP %i', async (status, category) => {
    const { service, provider } = setup();
    service.scripted.push({
      status,
      body: JSON.stringify({
        error: { code: 'Some_Code', message: `Input '${SECRET_TEXT}' rejected` },
      }),
    });
    const failure = await provider.embedText('peel').catch((error: unknown) => error);
    expect(failure).toMatchObject({ category, httpStatus: status, serviceCode: 'Some_Code' });
    expect(service.requests).toHaveLength(1);
    expect((failure as Error).message).not.toContain(SECRET_TEXT);
  });

  it('retries connection resets but not refused connections', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const fetchReset = vi.fn(() => Promise.reject(reset));
    await expect(setup({ fetch: fetchReset }).provider.embedText('x')).rejects.toMatchObject({
      category: 'network',
    });
    expect(fetchReset).toHaveBeenCalledTimes(4);
    const fetchRefused = vi.fn(() => Promise.reject(refused));
    await expect(setup({ fetch: fetchRefused }).provider.embedText('x')).rejects.toMatchObject({
      category: 'network',
      retryable: false,
    });
    expect(fetchRefused).toHaveBeenCalledTimes(1);
  });

  it('verifies returned dimensions and response shape', async () => {
    const wrong = setup();
    wrong.service.dimensions = DIMENSIONS + 1;
    await expect(wrong.provider.embedText('peel')).rejects.toMatchObject({
      category: 'dimension_mismatch',
    });

    for (const body of [
      '{"data":[]}',
      '{"data":[{"index":0,"embedding":[1,2,3,4,5,6,7,8]},{"index":0,"embedding":[1,2,3,4,5,6,7,8]}]}',
      '{"data":[{"index":5,"embedding":[1,2,3,4,5,6,7,8]}]}',
      'not json',
    ]) {
      const { service, provider } = setup();
      service.scripted.push({ status: 200, body });
      await expect(provider.embedText('peel')).rejects.toMatchObject({
        category: 'invalid_response',
      });
    }
  });

  it('does not follow redirects', async () => {
    const redirects: unknown[] = [];
    const { service, provider } = setup({
      fetch: (url, init) => {
        redirects.push(init.redirect);
        return service.fetch(url, init);
      },
    });
    await provider.embedText('peel');
    expect(redirects).toEqual(['manual']);
  });

  it('never logs text, vectors or the key, and keeps the key out of errors', async () => {
    const { service, provider, logLines } = setup();
    service.scripted.push(
      { status: 503 },
      {
        status: 401,
        body: JSON.stringify({ error: { code: '401', message: `Bad key ${API_KEY}` } }),
      },
    );
    const failure = await provider.embedText(SECRET_TEXT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmbeddingError);
    expect((failure as Error).message).not.toContain(API_KEY);
    await provider.embedText(SECRET_TEXT);
    const logs = logLines.join('\n');
    expect(logs).not.toContain(SECRET_TEXT);
    expect(logs).not.toContain(API_KEY);
    expect(logs).not.toContain(String(fakeVector(SECRET_TEXT, DIMENSIONS)[0]));
    expect(logs).toContain('Embeddings generated.');
  });

  it('authenticates with Entra ID tokens for the configured scope', async () => {
    const getToken = vi.fn(() =>
      Promise.resolve({ token: 'entra-token-value', expiresOnTimestamp: 0 }),
    );
    const service = new FakeEmbeddingService({
      bearerToken: 'entra-token-value',
      dimensions: DIMENSIONS,
    });
    const { provider } = setup({
      fetch: service.fetch,
      authenticator: tokenCredentialAuthenticator({ getToken }, 'https://ai.azure.com/.default'),
    });
    await provider.embedText('peel');
    expect(getToken).toHaveBeenCalledWith('https://ai.azure.com/.default', expect.anything());
  });

  it('reports health with the returned dimensions', async () => {
    const healthy = setup();
    expect(await healthy.provider.healthCheck()).toMatchObject({
      status: 'healthy',
      authMode: 'api-key',
      returnedDimensions: DIMENSIONS,
      expectedDimensions: DIMENSIONS,
      problems: [],
    });
    const mismatched = setup();
    mismatched.service.dimensions = 1536;
    expect(await mismatched.provider.healthCheck()).toMatchObject({
      status: 'unhealthy',
      returnedDimensions: 1536,
      failure: { category: 'dimension_mismatch' },
    });
    const denied = setup();
    denied.service.scripted.push({ status: 401 });
    expect(await denied.provider.healthCheck()).toMatchObject({
      status: 'unhealthy',
      failure: { category: 'authentication', httpStatus: 401 },
    });
  });
});

describe('limiters', () => {
  it('spaces requests evenly to stay under the per-minute rate', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RequestRateLimiter(
      120,
      () => now,
      (ms) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([500, 500]);
  });

  it('runs at most the configured number of tasks at once', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: string[] = [];
    await Promise.all(
      ['a', 'b'].map((name) =>
        limiter.run(async () => {
          order.push(`start ${name}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`end ${name}`);
        }),
      ),
    );
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});

describe('embedding cache', () => {
  it('does not regenerate unchanged text with the same model and version', async () => {
    const { service, provider } = setup();
    const caching = new CachingEmbeddingProvider(provider, new InMemoryEmbeddingCache());
    const first = await caching.embedBatch(['peel aftercare', 'laser safety']);
    const second = await caching.embedBatch(['peel  aftercare', 'laser safety', 'new text']);
    expect(service.requests.map((request) => request.body.input)).toEqual([
      ['peel aftercare', 'laser safety'],
      ['new text'],
    ]);
    expect(second.map((embedding) => embedding.cached)).toEqual([true, true, false]);
    expect(second[0]?.vector).toEqual(first[0]?.vector);
    // The original generation time is kept for cached vectors.
    expect(second[0]?.metadata.generatedAt).toBe(first[0]?.metadata.generatedAt);
    expect(caching.stats).toEqual({ hits: 2, misses: 3 });
  });

  it('regenerates when the model or embedding version changes', async () => {
    const cache = new InMemoryEmbeddingCache();
    const v1 = setup();
    await new CachingEmbeddingProvider(v1.provider, cache).embedText('peel');
    const v2 = setup({ embeddingVersion: '2' });
    await new CachingEmbeddingProvider(v2.provider, cache).embedText('peel');
    const large = setup({ modelIdentifier: 'text-embedding-3-large' });
    await new CachingEmbeddingProvider(large.provider, cache).embedText('peel');
    expect([v1, v2, large].map((context) => context.service.requests.length)).toEqual([1, 1, 1]);
  });

  it('persists entries in a file cache and ignores corrupt files', async () => {
    const directory = join(tempDirectory, 'files');
    const { service, provider } = setup();
    await new CachingEmbeddingProvider(provider, new FileEmbeddingCache(directory)).embedText(
      'peel',
    );
    const again = setup();
    const result = await new CachingEmbeddingProvider(
      again.provider,
      new FileEmbeddingCache(directory),
    ).embedText('peel');
    expect(result.cached).toBe(true);
    expect(again.service.requests).toHaveLength(0);
    expect(service.requests).toHaveLength(1);

    const [shard] = readdirSync(directory);
    const [file] = readdirSync(join(directory, shard ?? ''));
    writeFileSync(join(directory, shard ?? '', file ?? ''), '{"format":1,"vector":"oops"}');
    const third = setup();
    const regenerated = await new CachingEmbeddingProvider(
      third.provider,
      new FileEmbeddingCache(directory),
    ).embedText('peel');
    expect(regenerated.cached).toBe(false);
    expect(third.service.requests).toHaveLength(1);
  });

  it('evicts the least recently used in-memory entry', async () => {
    const cache = new InMemoryEmbeddingCache(2);
    const { provider } = setup();
    const [a, b, c] = await provider.embedBatch(['a', 'b', 'c']);
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('fixture');
    }
    await cache.setMany([a, b]);
    await cache.getMany([a.metadata.cacheKey]);
    await cache.setMany([c]);
    const found = await cache.getMany([
      a.metadata.cacheKey,
      b.metadata.cacheKey,
      c.metadata.cacheKey,
    ]);
    expect([...found.keys()]).toEqual([a.metadata.cacheKey, c.metadata.cacheKey]);
  });
});

describe('createEmbeddingProvider', () => {
  const settings: EmbeddingSettings = {
    AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
    AZURE_OPENAI_TOKEN_SCOPE: 'https://ai.azure.com/.default',
    AZURE_OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
    AZURE_OPENAI_EMBEDDING_DIMENSIONS: DIMENSIONS,
    AZURE_OPENAI_EMBEDDING_SEND_DIMENSIONS: false,
    EMBEDDING_VERSION: '1',
    EMBEDDING_BATCH_SIZE: 16,
    EMBEDDING_MAX_BATCH_TOKENS: 100_000,
    EMBEDDING_MAX_INPUT_TOKENS: 8191,
    EMBEDDING_MAX_CONCURRENCY: 1,
    EMBEDDING_REQUESTS_PER_MINUTE: 6000,
    EMBEDDING_REQUEST_TIMEOUT_MS: 5000,
    EMBEDDING_MAX_RETRIES: 0,
  };

  it('uses the API key when configured and Entra ID otherwise', async () => {
    const keyService = new FakeEmbeddingService({ apiKey: API_KEY, dimensions: DIMENSIONS });
    const createCredential = vi.fn(() =>
      Promise.resolve({
        getToken: () => Promise.resolve({ token: 'mi-token', expiresOnTimestamp: 0 }),
      }),
    );
    const withKey = await createEmbeddingProvider(
      { ...settings, AZURE_OPENAI_API_KEY: API_KEY },
      { fetch: keyService.fetch, createCredential },
    );
    expect((await withKey.healthCheck()).authMode).toBe('api-key');
    expect(createCredential).not.toHaveBeenCalled();

    const miService = new FakeEmbeddingService({ bearerToken: 'mi-token', dimensions: DIMENSIONS });
    const withIdentity = await createEmbeddingProvider(settings, {
      fetch: miService.fetch,
      createCredential,
    });
    expect((await withIdentity.healthCheck()).status).toBe('healthy');
    expect(createCredential).toHaveBeenCalledTimes(1);
  });
});
