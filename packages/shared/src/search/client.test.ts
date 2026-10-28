import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logging/logger.js';
import { clearRegisteredSecretValues } from '../logging/redaction.js';
import { FakeSearchService } from './__fixtures__/fakeSearchService.js';
import {
  TEST_DIMENSIONS,
  makeSearchDocument,
  placeholderVector,
} from './__fixtures__/documents.js';
import {
  SEARCH_TOKEN_SCOPE,
  apiKeyAuthenticator,
  tokenCredentialAuthenticator,
  type SearchTokenCredential,
} from './auth.js';
import { RestSearchIndexClient, type RestSearchIndexClientOptions } from './client.js';
import { SearchServiceError } from './errors.js';
import { createSearchIndexClient } from './factory.js';
import { MissingPrincipalsError } from './odata.js';

const API_KEY = 'fake-search-admin-key-0123456789abcdef';
const ENDPOINT = 'https://search.example.test';
const INDEX = 'ehub-course-content-v1';

afterEach(() => {
  clearRegisteredSecretValues();
});

function setup(overrides: Partial<RestSearchIndexClientOptions> = {}) {
  const service = new FakeSearchService({ apiKey: API_KEY });
  const logLines: string[] = [];
  const sleeps: number[] = [];
  const client = new RestSearchIndexClient({
    endpoint: ENDPOINT,
    indexName: INDEX,
    vectorDimensions: TEST_DIMENSIONS,
    semanticEnabled: true,
    authenticator: apiKeyAuthenticator(API_KEY),
    fetch: service.fetch,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logLines.push(line) },
    }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...overrides,
  });
  return { service, client, logLines, sleeps };
}

const principals = { userIds: ['user-1'], groupIds: [] };

describe('RestSearchIndexClient index management', () => {
  it('creates a missing index with a create-only request', async () => {
    const { service, client } = setup();
    const result = await client.createOrUpdateIndex();
    expect(result.outcome).toBe('created');
    expect(result.validation.status).toBe('missing');
    const put = service.requests.find((request) => request.method === 'PUT');
    expect(put?.headers['if-none-match']).toBe('*');
    expect(put?.headers['api-key']).toBe(API_KEY);
    expect(put?.query.get('api-version')).toBe('2026-04-01');
    expect(service.indexes.has(INDEX)).toBe(true);
  });

  it('reports an index created from the same definition as unchanged and valid', async () => {
    const { service, client } = setup();
    await client.createOrUpdateIndex();
    const requestsBefore = service.requests.length;
    expect((await client.createOrUpdateIndex()).outcome).toBe('unchanged');
    expect((await client.validateIndexSchema()).status).toBe('match');
    expect(
      service.requests.slice(requestsBefore).every((request) => request.method === 'GET'),
    ).toBe(true);
  });

  it('leaves compatible changes pending unless asked, then applies them with If-Match', async () => {
    const { service, client } = setup({ semanticEnabled: false });
    await client.createOrUpdateIndex();

    const { client: newer } = setup({ fetch: service.fetch });
    const validation = await newer.validateIndexSchema();
    expect(validation.status).toBe('compatible-changes');

    const pending = await newer.createOrUpdateIndex();
    expect(pending.outcome).toBe('changes-pending');
    expect(service.indexes.get(INDEX)?.definition['semantic']).toBeUndefined();

    const applied = await newer.createOrUpdateIndex({ applyCompatibleChanges: true });
    expect(applied.outcome).toBe('updated');
    const update = service.requests.filter((request) => request.method === 'PUT').at(-1);
    expect(update?.headers['if-match']).toBe('"0x1"');
    expect((await newer.validateIndexSchema()).status).toBe('match');
  });

  it('never modifies an index whose schema needs a migration', async () => {
    const { service, client } = setup();
    await client.createOrUpdateIndex();
    const { client: wider } = setup({ fetch: service.fetch, vectorDimensions: 16 });
    const result = await wider.createOrUpdateIndex({ applyCompatibleChanges: true });
    expect(result.outcome).toBe('migration-required');
    expect(result.validation.differences).toContainEqual(
      expect.objectContaining({ field: 'contentVector', attribute: 'dimensions' }),
    );
    expect(service.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('surfaces a concurrent change as a precondition failure instead of overwriting', async () => {
    const { service, client } = setup({ semanticEnabled: false });
    await client.createOrUpdateIndex();
    const realFetch = service.fetch;
    let bumped = false;
    const racing: typeof realFetch = async (input, init) => {
      if (init.method === 'PUT' && !bumped) {
        bumped = true;
        const stored = service.indexes.get(INDEX);
        if (stored !== undefined) {
          stored.etag += 1;
        }
      }
      return realFetch(input, init);
    };
    const { client: raced } = setup({ fetch: racing });
    await expect(raced.createOrUpdateIndex({ applyCompatibleChanges: true })).rejects.toMatchObject(
      { category: 'precondition_failed', httpStatus: 412 },
    );
    expect(service.indexes.get(INDEX)?.definition['semantic']).toBeUndefined();
  });
});

describe('RestSearchIndexClient documents', () => {
  it('uploads documents in batches limited by count', async () => {
    const { service, client } = setup({ batchSize: 2 });
    await client.createOrUpdateIndex();
    const documents = ['a', 'b', 'c', 'd', 'e'].map((seed) => makeSearchDocument({ seed }));
    const report = await client.uploadChunks(documents);
    expect(report).toMatchObject({ action: 'upload', attempted: 5, succeeded: 5, failed: [] });
    expect(report.requests).toBe(3);
    expect(service.documents.get(INDEX)?.size).toBe(5);
  });

  it('splits batches by request size', async () => {
    const { service, client } = setup({ maxBatchBytes: 4096 });
    await client.createOrUpdateIndex();
    const documents = ['a', 'b', 'c'].map((seed) =>
      makeSearchDocument({ seed, content: seed.repeat(1500) }),
    );
    const report = await client.uploadChunks(documents);
    expect(report.succeeded).toBe(3);
    expect(report.requests).toBe(3);
    const tooBig = await client.uploadChunks([
      makeSearchDocument({ seed: 'huge', content: 'x'.repeat(5000) }),
    ]);
    expect(tooBig.failed).toEqual([expect.objectContaining({ reason: 'too-large' })]);
    expect(service.documents.get(INDEX)?.size).toBe(3);
  });

  it('retries only documents with transient per-document failures', async () => {
    const { service, client, sleeps } = setup();
    await client.createOrUpdateIndex();
    const documents = ['a', 'b', 'c'].map((seed) => makeSearchDocument({ seed }));
    const [first, second, third] = documents;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('fixture');
    }
    service.documentFailures.set(first.id, [503, 409]);
    service.documentFailures.set(second.id, [400]);
    const before = service.requests.length;
    const report = await client.mergeOrUploadChunks(documents);
    expect(report.succeeded).toBe(2);
    expect(report.retriedDocuments).toBe(2);
    expect(report.failed).toEqual([
      expect.objectContaining({ key: second.id, reason: 'rejected', statusCode: 400 }),
    ]);
    // The per-document message echoed document content; only a placeholder survives.
    expect(report.failed[0]?.message).toBe("Document failed with value '[value]'.");
    expect(service.requests.length - before).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('gives up on a transient per-document failure after the retry budget', async () => {
    const { service, client } = setup({
      retryPolicy: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
    });
    await client.createOrUpdateIndex();
    const document = makeSearchDocument();
    service.documentFailures.set(document.id, [503, 503, 503]);
    const report = await client.uploadChunks([document]);
    expect(report.failed).toEqual([
      expect.objectContaining({ reason: 'retries-exhausted', statusCode: 503 }),
    ]);
  });

  it('retries whole requests on throttling, honouring Retry-After', async () => {
    const { service, client, sleeps } = setup();
    await client.createOrUpdateIndex();
    service.scriptedResponses.push(
      { status: 503, headers: { 'retry-after': '2' }, body: '' },
      { status: 429, headers: { 'retry-after-ms': '1500' }, body: '' },
    );
    const report = await client.uploadChunks([makeSearchDocument()]);
    expect(report.succeeded).toBe(1);
    expect(sleeps).toEqual([2000, 1500]);
  });

  it('marks a batch the service rejects as a whole and carries on', async () => {
    const { service, client } = setup({ batchSize: 1 });
    await client.createOrUpdateIndex();
    service.scriptedResponses.push({
      status: 400,
      body: JSON.stringify({ error: { code: 'InvalidDocument', message: "Bad value 'secret'" } }),
    });
    const report = await client.uploadChunks([
      makeSearchDocument({ seed: 'a' }),
      makeSearchDocument({ seed: 'b' }),
    ]);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.message).not.toContain('secret');
  });

  it('splits a batch the service says is too large', async () => {
    const { service, client } = setup();
    await client.createOrUpdateIndex();
    service.scriptedResponses.push({ status: 413, body: '' });
    const report = await client.uploadChunks(
      ['a', 'b', 'c'].map((seed) => makeSearchDocument({ seed })),
    );
    expect(report.succeeded).toBe(3);
    expect(report.requests).toBe(3);
  });

  it('stops at authentication failures and keeps the key out of errors and logs', async () => {
    const { service, client, logLines } = setup();
    await client.createOrUpdateIndex();
    service.scriptedResponses.push({
      status: 401,
      body: JSON.stringify({ error: { code: 'Unauthorized', message: `key ${API_KEY} denied` } }),
    });
    const failure = await client
      .uploadChunks([makeSearchDocument()])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SearchServiceError);
    expect(failure).toMatchObject({
      category: 'authentication',
      httpStatus: 401,
      retryable: false,
    });
    expect((failure as Error).message).not.toContain(API_KEY);
    expect(logLines.join('\n')).not.toContain(API_KEY);
    expect(logLines.join('\n')).not.toContain('Aftercare guidance');
  });

  it('validates documents before any network traffic', async () => {
    const { service, client } = setup();
    const invalid = [
      makeSearchDocument({ contentVector: placeholderVector('x', TEST_DIMENSIONS + 1) }),
      { ...makeSearchDocument(), id: 'not-hex' },
      { ...makeSearchDocument(), indexedAt: '28 October 2026' },
      { ...makeSearchDocument(), unexpected: true },
    ];
    for (const document of invalid) {
      await expect(client.uploadChunks([document])).rejects.toMatchObject({
        category: 'invalid_request',
      });
    }
    await expect(client.uploadChunks([makeSearchDocument(), makeSearchDocument()])).rejects.toThrow(
      /more than once/,
    );
    const contentFailure = await client
      .uploadChunks([{ ...makeSearchDocument({ content: 'Confidential note' }), courseId: -1 }])
      .catch((error: unknown) => error);
    expect((contentFailure as Error).message).not.toContain('Confidential');
    expect(service.requests).toHaveLength(0);
  });

  it('deletes every chunk of a resource, paging keys past 1000', async () => {
    const { service, client } = setup();
    await client.createOrUpdateIndex();
    const target = Array.from({ length: 1205 }, (_, i) =>
      makeSearchDocument({ seed: `t-${String(i)}`, resourceId: "702:file:/O'Brien.pdf" }),
    );
    const keep = [
      makeSearchDocument({ seed: 'other-resource', resourceId: '701:page' }),
      makeSearchDocument({
        seed: 'other-course',
        courseId: 99,
        resourceId: "702:file:/O'Brien.pdf",
      }),
      makeSearchDocument({
        seed: 'other-tenant',
        tenantId: 'tenant-2',
        resourceId: "702:file:/O'Brien.pdf",
      }),
    ];
    service.seed(INDEX, [...target, ...keep]);
    const report = await client.deleteChunksByResource({
      tenantId: 'tenant-1',
      courseId: 12,
      resourceId: "702:file:/O'Brien.pdf",
    });
    expect(report).toMatchObject({ matched: 1205, succeeded: 1205, failed: [] });
    expect([...(service.documents.get(INDEX)?.keys() ?? [])].sort()).toEqual(
      keep.map((document) => document.id).sort(),
    );
    const listing = service.requests.filter((request) => request.path.endsWith('/docs/search'));
    expect(listing).toHaveLength(2);
    expect(JSON.parse(listing[1]?.body ?? '{}')).toMatchObject({
      orderby: 'id asc',
      select: 'id',
      filter: expect.stringContaining(' and id gt ') as unknown,
    });
  });

  it('deletes every chunk of a course within one tenant only', async () => {
    const { service, client } = setup();
    await client.createOrUpdateIndex();
    service.seed(INDEX, [
      makeSearchDocument({ seed: 'a' }),
      makeSearchDocument({ seed: 'b', resourceId: '701:page' }),
      makeSearchDocument({ seed: 'c', courseId: 13 }),
      makeSearchDocument({ seed: 'd', tenantId: 'tenant-2' }),
    ]);
    const report = await client.deleteChunksByCourse({ tenantId: 'tenant-1', courseId: 12 });
    expect(report.matched).toBe(2);
    expect(service.documents.get(INDEX)?.size).toBe(2);
    await expect(
      client.deleteChunksByCourse({ tenantId: "x' or '1", courseId: 12 }),
    ).rejects.toThrow(/Invalid tenant ID/);
  });
});

describe('RestSearchIndexClient search', () => {
  async function seeded() {
    const context = setup();
    await context.client.createOrUpdateIndex();
    context.service.seed(INDEX, [
      makeSearchDocument({ seed: 'mine' }),
      makeSearchDocument({ seed: 'group', allowedUserIds: [], allowedGroupIds: ['group-7'] }),
      makeSearchDocument({ seed: 'other', allowedUserIds: ['user-2'], allowedGroupIds: [] }),
      makeSearchDocument({ seed: 'nobody', allowedUserIds: [], allowedGroupIds: [] }),
      makeSearchDocument({ seed: 'inactive', isActive: false }),
      makeSearchDocument({ seed: 'tenant', tenantId: 'tenant-2' }),
    ]);
    return context;
  }

  it('returns only chunks the caller may see, without access lists or vectors', async () => {
    const { client, service } = await seeded();
    const results = await client.search({
      tenantId: 'tenant-1',
      principals: { userIds: ['user-1'], groupIds: ['group-7'] },
      text: 'aftercare',
      top: 10,
    });
    expect(results.hits).toHaveLength(2);
    expect(results.semanticApplied).toBe(true);
    expect(results.hits[0]?.rerankerScore).toBeTypeOf('number');
    for (const hit of results.hits) {
      expect(hit.document).not.toHaveProperty('allowedUserIds');
      expect(hit.document).not.toHaveProperty('contentVector');
    }
    const body = JSON.parse(service.requests.at(-1)?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ queryType: 'semantic', semanticConfiguration: 'ehub-semantic' });
    expect(body['filter']).toContain("tenantId eq 'tenant-1' and isActive eq true");
  });

  it('fails closed before any request when the caller has no principals', async () => {
    const { client, service } = await seeded();
    const before = service.requests.length;
    await expect(
      client.search({ tenantId: 'tenant-1', principals: { userIds: [], groupIds: [] }, text: 'x' }),
    ).rejects.toThrow(MissingPrincipalsError);
    expect(service.requests.length).toBe(before);
  });

  it('pre-filters vector queries and checks the vector size', async () => {
    const { client, service } = await seeded();
    const results = await client.search({
      tenantId: 'tenant-1',
      principals,
      vector: placeholderVector('aftercare', TEST_DIMENSIONS),
      courseIds: [12],
    });
    expect(results.hits).toHaveLength(1);
    expect(results.semanticApplied).toBe(false);
    const body = JSON.parse(service.requests.at(-1)?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ vectorFilterMode: 'preFilter', queryType: 'simple' });
    expect(body['filter']).toContain('(courseId eq 12)');
    await expect(
      client.search({ tenantId: 'tenant-1', principals, vector: [1, 2] }),
    ).rejects.toMatchObject({ category: 'invalid_request' });
    await expect(client.search({ tenantId: 'tenant-1', principals })).rejects.toMatchObject({
      category: 'invalid_request',
    });
    await expect(
      client.search({ tenantId: 'tenant-1', principals, text: 'x', top: 51 }),
    ).rejects.toMatchObject({ category: 'invalid_request' });
  });

  it("rejects a response containing another tenant's document", async () => {
    const { client, service } = await seeded();
    service.scriptedResponses.push({
      status: 200,
      body: JSON.stringify({
        value: [
          {
            '@search.score': 1,
            ...makeSearchDocument({ tenantId: 'tenant-2' }),
            contentVector: undefined,
            allowedUserIds: undefined,
            allowedGroupIds: undefined,
          },
        ],
      }),
    });
    await expect(
      client.search({ tenantId: 'tenant-1', principals, text: 'x' }),
    ).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('does not follow redirects', async () => {
    const { client, service } = await seeded();
    service.scriptedResponses.push({ status: 307, headers: { location: 'https://evil.test/' } });
    await expect(
      client.search({ tenantId: 'tenant-1', principals, text: 'x' }),
    ).rejects.toMatchObject({ category: 'invalid_response', httpStatus: 307 });
  });

  it('asks fetch not to follow redirects, which would resend the key to another host', async () => {
    const service = new FakeSearchService({ apiKey: API_KEY });
    const redirects: unknown[] = [];
    const { client } = setup({
      fetch: (input, init) => {
        redirects.push(init.redirect);
        return service.fetch(input, init);
      },
    });
    await client.validateIndexSchema();
    expect(redirects).toEqual(['manual']);
  });

  it('does not include query text in errors', async () => {
    const { client, service } = await seeded();
    service.scriptedResponses.push({
      status: 400,
      body: JSON.stringify({
        error: { code: 'InvalidRequest', message: 'Bad query "my secret question"' },
      }),
    });
    const failure = await client
      .search({ tenantId: 'tenant-1', principals, text: 'my secret question' })
      .catch((error: unknown) => error);
    expect((failure as Error).message).not.toContain('secret question');
  });
});

describe('RestSearchIndexClient health and transport', () => {
  it('reports a healthy service and index', async () => {
    const { client, service } = setup();
    await client.createOrUpdateIndex();
    service.seed(INDEX, [makeSearchDocument()]);
    const report = await client.healthCheck();
    expect(report).toMatchObject({
      status: 'healthy',
      authMode: 'api-key',
      serviceReachable: true,
      schema: 'match',
      index: { exists: true, documentCount: 1, storageSizeBytes: 2048, vectorIndexSizeBytes: 512 },
      problems: [],
    });
    expect(report.serviceCounters?.['indexesCount']).toEqual({ usage: 1, quota: 15 });
  });

  it('degrades when service statistics are forbidden and fails when the index is missing', async () => {
    const { client, service } = setup();
    service.serviceStatsStatus = 403;
    const missing = await client.healthCheck();
    expect(missing.status).toBe('unhealthy');
    expect(missing.index).toEqual({ exists: false });
    await client.createOrUpdateIndex();
    const degraded = await client.healthCheck();
    expect(degraded.status).toBe('degraded');
    expect(degraded.problems[0]).toContain('403');
  });

  it('reports an unreachable service after retrying transient network errors', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
    });
    const fetch = vi.fn(() => Promise.reject(reset));
    const { client, sleeps } = setup({ fetch });
    const report = await client.healthCheck();
    expect(report).toMatchObject({ status: 'unhealthy', serviceReachable: false });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });

  it('does not retry refused connections or 4xx responses', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    });
    const fetch = vi.fn(() => Promise.reject(refused));
    const { client } = setup({ fetch });
    await expect(client.validateIndexSchema()).rejects.toMatchObject({
      category: 'network',
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out slow requests', async () => {
    const fetch = vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const { client } = setup({
      fetch,
      requestTimeoutMs: 20,
      retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
    });
    await expect(client.validateIndexSchema()).rejects.toMatchObject({ category: 'timeout' });
  });

  it('rejects endpoints that are not plain https origins', () => {
    for (const endpoint of [
      'http://search.example.test',
      'https://user:pw@search.example.test',
      'https://search.example.test/indexes',
      'not a url',
    ]) {
      expect(() => setup({ endpoint })).toThrow(TypeError);
    }
  });
});

describe('authentication', () => {
  it('requests Entra ID tokens for the Azure AI Search scope', async () => {
    const getToken = vi.fn<SearchTokenCredential['getToken']>(() =>
      Promise.resolve({ token: 'entra-token-value', expiresOnTimestamp: Date.now() + 60_000 }),
    );
    const service = new FakeSearchService({ bearerToken: 'entra-token-value' });
    const client = new RestSearchIndexClient({
      endpoint: ENDPOINT,
      indexName: INDEX,
      vectorDimensions: TEST_DIMENSIONS,
      semanticEnabled: false,
      authenticator: tokenCredentialAuthenticator({ getToken }),
      fetch: service.fetch,
    });
    expect((await client.validateIndexSchema()).status).toBe('missing');
    expect(getToken).toHaveBeenCalledWith(SEARCH_TOKEN_SCOPE, expect.anything());
  });

  it('fails closed with a generic message when no token can be obtained', async () => {
    const authenticator = tokenCredentialAuthenticator({
      getToken: () =>
        Promise.reject(new Error('ManagedIdentityCredential: detailed environment info')),
    });
    const service = new FakeSearchService({ bearerToken: 'x' });
    const client = new RestSearchIndexClient({
      endpoint: ENDPOINT,
      indexName: INDEX,
      vectorDimensions: TEST_DIMENSIONS,
      semanticEnabled: false,
      authenticator,
      fetch: service.fetch,
    });
    const failure = await client.validateIndexSchema().catch((error: unknown) => error);
    expect(failure).toMatchObject({ category: 'authentication' });
    expect((failure as Error).message).not.toContain('detailed environment');
    expect(service.requests).toHaveLength(0);
  });

  it('chooses the API key when configured and Entra ID otherwise', async () => {
    const settings = {
      AZURE_SEARCH_ENDPOINT: ENDPOINT,
      AZURE_SEARCH_INDEX_NAME: INDEX,
      AZURE_SEARCH_VECTOR_DIMENSIONS: TEST_DIMENSIONS,
      AZURE_SEARCH_SEMANTIC_ENABLED: true,
      AZURE_SEARCH_BATCH_SIZE: 100,
      AZURE_SEARCH_REQUEST_TIMEOUT_MS: 5_000,
      AZURE_SEARCH_MAX_RETRIES: 0,
    };
    const createCredential = vi.fn(() =>
      Promise.resolve<SearchTokenCredential>({
        getToken: () => Promise.resolve({ token: 'mi-token', expiresOnTimestamp: 0 }),
      }),
    );
    const keyService = new FakeSearchService({ apiKey: API_KEY });
    const withKey = await createSearchIndexClient(
      { ...settings, AZURE_SEARCH_API_KEY: API_KEY },
      { fetch: keyService.fetch, createCredential },
    );
    expect((await withKey.healthCheck()).authMode).toBe('api-key');
    expect(createCredential).not.toHaveBeenCalled();

    const miService = new FakeSearchService({ bearerToken: 'mi-token' });
    const withIdentity = await createSearchIndexClient(settings, {
      fetch: miService.fetch,
      createCredential,
    });
    expect((await withIdentity.healthCheck()).authMode).toBe('entra-id');
    expect(createCredential).toHaveBeenCalledTimes(1);
  });
});
