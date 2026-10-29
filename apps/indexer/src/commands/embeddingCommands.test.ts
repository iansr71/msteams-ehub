import { createLogger, type CommandContext } from '@ehub/shared';
import { createEmbeddingProvider } from '@ehub/shared/embeddings';
import { RestSearchIndexClient, apiKeyAuthenticator } from '@ehub/shared/search';
import { describe, expect, it } from 'vitest';

import { FakeEmbeddingService } from '../../../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import { FakeSearchService } from '../../../../packages/shared/src/search/__fixtures__/fakeSearchService.js';
import { createEmbeddingCommands } from './embeddingCommands.js';
import type { EmbeddingCommandDependencies } from './embeddingServices.js';

const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';
const SEARCH_KEY = 'fake-search-admin-key-0123456789abcdef';
const SECRET_TEXT = 'consultation requirements for Jane Doe';

const embeddingEnv = {
  AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
  AZURE_OPENAI_API_KEY: OPENAI_KEY,
  AZURE_OPENAI_EMBEDDING_DIMENSIONS: '8',
};
const searchEnv = {
  AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
  AZURE_SEARCH_API_KEY: SEARCH_KEY,
  AZURE_SEARCH_VECTOR_DIMENSIONS: '8',
};

async function run(
  command: 'embeddings:health' | 'embeddings:test',
  args: string[],
  options: {
    env?: Record<string, string>;
    returnedDimensions?: number;
    indexDimensions?: number;
    embeddingStatus?: number;
  } = {},
) {
  const embeddings = new FakeEmbeddingService({
    apiKey: OPENAI_KEY,
    dimensions: options.returnedDimensions ?? 8,
  });
  if (options.embeddingStatus !== undefined) {
    embeddings.scripted.push({ status: options.embeddingStatus });
  }
  const search = new FakeSearchService({ apiKey: SEARCH_KEY });
  const searchClient = (dimensions: number) =>
    new RestSearchIndexClient({
      endpoint: 'https://search.example.test',
      indexName: 'ehub-course-content-v1',
      vectorDimensions: dimensions,
      semanticEnabled: true,
      authenticator: apiKeyAuthenticator(SEARCH_KEY),
      fetch: search.fetch,
    });
  if (options.indexDimensions !== undefined) {
    await searchClient(options.indexDimensions).createOrUpdateIndex();
  }
  const output: string[] = [];
  const logs: string[] = [];
  const context: CommandContext = {
    args,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logs.push(line) },
    }),
    stdout: (text) => output.push(text),
  };
  const dependencies: EmbeddingCommandDependencies = {
    env: options.env ?? { ...embeddingEnv, ...searchEnv },
    createEmbedder: (settings, logger) =>
      createEmbeddingProvider(settings, { fetch: embeddings.fetch, logger }),
    createSearch: (settings) =>
      Promise.resolve(searchClient(settings.AZURE_SEARCH_VECTOR_DIMENSIONS)),
  };
  const definition = createEmbeddingCommands(dependencies)[command];
  if (definition === undefined) {
    throw new Error('missing command');
  }
  const exitCode = await definition.run(context);
  const stdout = output.join('\n');
  const logText = logs.join('\n');
  for (const text of [stdout, logText]) {
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(SEARCH_KEY);
    expect(text).not.toContain(SECRET_TEXT);
  }
  return { exitCode, stdout, logText, embeddings };
}

describe('embeddings:health', () => {
  it('passes when the deployment, configuration and deployed index agree', async () => {
    const result = await run('embeddings:health', [], { indexDimensions: 8 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Embeddings: HEALTHY');
    expect(result.stdout).toContain('Dimensions: expected 8, returned 8');
    expect(result.stdout).toContain('Search index dimensions: configured 8, deployed 8');
  });

  it('fails when the deployment returns a different size', async () => {
    const result = await run('embeddings:health', ['--json'], {
      indexDimensions: 8,
      returnedDimensions: 1536,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'unhealthy',
      embedding: { returnedDimensions: 1536, failure: { category: 'dimension_mismatch' } },
    });
  });

  it('fails when the search configuration or deployed index disagree', async () => {
    const configured = await run('embeddings:health', [], {
      env: { ...embeddingEnv, ...searchEnv, AZURE_SEARCH_VECTOR_DIMENSIONS: '16' },
      indexDimensions: 16,
    });
    expect(configured.exitCode).toBe(1);
    expect(configured.stdout).toContain(
      'AZURE_OPENAI_EMBEDDING_DIMENSIONS (8) does not match AZURE_SEARCH_VECTOR_DIMENSIONS (16)',
    );
    const deployed = await run('embeddings:health', [], { indexDimensions: 16 });
    expect(deployed.exitCode).toBe(1);
    expect(deployed.stdout).toContain('The deployed index stores 16-dimension vectors');
  });

  it('reports a missing index and unconfigured search without failing embeddings', async () => {
    const missing = await run('embeddings:health', []);
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout).toContain('does not exist yet');
    const noSearch = await run('embeddings:health', [], { env: embeddingEnv });
    expect(noSearch.exitCode).toBe(0);
    expect(noSearch.stdout).toContain('Azure AI Search is not configured');
  });

  it('explains authentication failures', async () => {
    const result = await run('embeddings:health', [], { embeddingStatus: 401, indexDimensions: 8 });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Hint: Locally, check AZURE_OPENAI_API_KEY');
  });

  it('names missing variables', async () => {
    const result = await run('embeddings:health', [], { env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('AZURE_OPENAI_ENDPOINT: Required.');
  });
});

describe('embeddings:test', () => {
  it('shows metadata and a short preview, never the text or the whole vector', async () => {
    const result = await run('embeddings:test', ['--text', SECRET_TEXT]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Embedding: 8 dimensions from text-embedding-3-small (version 1)',
    );
    expect(result.stdout).toContain('First 5 values: [');
    expect(result.stdout).toContain('(use --show-vector for all)');
    const json = await run('embeddings:test', ['--text', SECRET_TEXT, '--json']);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      dimensions: 8,
      cached: false,
      textCharacters: SECRET_TEXT.length,
    });
    expect(parsed).not.toHaveProperty('vector');
    expect(parsed['vectorPreview']).toHaveLength(5);
  });

  it('prints the whole vector only with --show-vector', async () => {
    const result = await run('embeddings:test', ['--text', 'peel', '--show-vector', '--json']);
    expect((JSON.parse(result.stdout) as { vector: number[] }).vector).toHaveLength(8);
  });

  it('rejects empty text and unknown options', async () => {
    const empty = await run('embeddings:test', ['--text', ' \u200b ']);
    expect(empty.exitCode).toBe(1);
    expect(empty.stdout).toContain('invalid_input');
    expect(empty.embeddings.requests).toHaveLength(0);
    const unknown = await run('embeddings:test', ['--text', 'x', '--all']);
    expect(unknown.exitCode).toBe(2);
  });
});
