import {
  CachingEmbeddingProvider,
  InMemoryEmbeddingCache,
  AzureOpenAIEmbeddingProvider,
} from '@ehub/shared/embeddings';
import { apiKeyAuthenticator } from '@ehub/shared/search';
import { describe, expect, it } from 'vitest';

import { FakeEmbeddingService } from '../../../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import {
  CHUNKER_VERSION,
  buildChunkId,
  contentChunkSchema,
  hashChunkContent,
  type ContentChunk,
} from '../pipeline/chunkMetadata.js';
import { embedChunks } from './chunkEmbedder.js';
import { VectorDimensionError } from './searchDocuments.js';

const KEY = 'fake-openai-key-0123456789abcdef0123';

function chunk(number: number, content: string): ContentChunk {
  return contentChunkSchema.parse({
    chunkId: buildChunkId('tenant-1', 12, '701:page', number),
    tenantId: 'tenant-1',
    courseId: 12,
    courseName: 'Consultation Skills',
    sectionId: 1,
    sectionName: 'Aftercare',
    moduleId: 701,
    moduleName: 'Aftercare',
    resourceId: '701:page',
    resourceName: 'Aftercare',
    resourceType: 'moodle-page',
    fileName: 'index.html',
    title: 'Sun protection',
    headingPath: ['Sun protection'],
    content,
    chunkNumber: number,
    chunkCount: 2,
    tokenCount: 10,
    overlapTokens: 0,
    contentHash: hashChunkContent(content),
    sourceContentHash: hashChunkContent('page'),
    indexedAt: '2026-10-29T08:00:00.000Z',
    extractorVersion: 'html@1.0.0',
    chunkerVersion: CHUNKER_VERSION,
    allowedUserIds: [],
    allowedGroupIds: [],
    isActive: true,
  });
}

function provider(service: FakeEmbeddingService, version = '1') {
  return new AzureOpenAIEmbeddingProvider({
    endpoint: 'https://contoso.openai.azure.com',
    deployment: 'embed',
    modelIdentifier: 'text-embedding-3-small',
    embeddingVersion: version,
    dimensions: 8,
    sendDimensions: false,
    authenticator: apiKeyAuthenticator(KEY),
    batchSize: 16,
    maxBatchTokens: 100_000,
    maxInputTokens: 8191,
    maxConcurrency: 1,
    requestsPerMinute: 60_000,
    requestTimeoutMs: 5_000,
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
    fetch: service.fetch,
    clock: () => new Date('2026-10-29T10:00:00.000Z'),
  });
}

describe('embedChunks', () => {
  it('builds index documents with embedding metadata, embedding heading context and content', async () => {
    const service = new FakeEmbeddingService({ apiKey: KEY, dimensions: 8 });
    const result = await embedChunks(
      [chunk(1, 'Use SPF 50.'), chunk(2, 'Avoid sun.')],
      provider(service),
      8,
    );
    expect(result).toMatchObject({ generated: 2, cached: 0 });
    expect(service.requests[0]?.body.input).toEqual([
      'Aftercare > Sun protection Use SPF 50.',
      'Aftercare > Sun protection Avoid sun.',
    ]);
    expect(result.documents[0]).toMatchObject({
      embeddingModel: 'text-embedding-3-small',
      embeddingVersion: '1',
      embeddingDimensions: 8,
      embeddedAt: '2026-10-29T10:00:00.000Z',
    });
    expect(result.documents[0]?.contentVector).toHaveLength(8);
  });

  it('does not re-embed unchanged chunks with the same model and version', async () => {
    const service = new FakeEmbeddingService({ apiKey: KEY, dimensions: 8 });
    const cache = new InMemoryEmbeddingCache();
    const cached = new CachingEmbeddingProvider(provider(service), cache);
    await embedChunks([chunk(1, 'Use SPF 50.'), chunk(2, 'Avoid sun.')], cached, 8);
    const second = await embedChunks(
      [chunk(1, 'Use SPF 50.'), chunk(2, 'Avoid direct sun.')],
      cached,
      8,
    );
    expect(second).toMatchObject({ generated: 1, cached: 1 });
    expect(service.requests.at(-1)?.body.input).toEqual([
      'Aftercare > Sun protection Avoid direct sun.',
    ]);

    const bumped = new CachingEmbeddingProvider(provider(service, '2'), cache);
    expect(await embedChunks([chunk(1, 'Use SPF 50.')], bumped, 8)).toMatchObject({
      generated: 1,
      cached: 0,
    });
  });

  it('refuses a provider whose dimensions differ from the index', async () => {
    const service = new FakeEmbeddingService({ apiKey: KEY, dimensions: 8 });
    await expect(embedChunks([chunk(1, 'x')], provider(service), 16)).rejects.toThrow(
      VectorDimensionError,
    );
    expect(service.requests).toHaveLength(0);
  });
});
