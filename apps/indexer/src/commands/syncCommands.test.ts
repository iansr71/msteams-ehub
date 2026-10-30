import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type CommandContext } from '@ehub/shared';
import { AzureOpenAIEmbeddingProvider, type EmbeddingProvider } from '@ehub/shared/embeddings';
import { RestSearchIndexClient, apiKeyAuthenticator } from '@ehub/shared/search';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeEmbeddingService } from '../../../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import { FakeSearchService } from '../../../../packages/shared/src/search/__fixtures__/fakeSearchService.js';
import { FakeMoodleSite, pageHtml } from '../jobs/__fixtures__/syncHarness.js';
import { FIXTURE_BASE_URL } from '../moodle/__fixtures__/fixtureClient.js';
import { InMemorySyncStateRepository } from '../state/inMemorySyncStateRepository.js';
import { createSyncCommands } from './syncCommands.js';
import type { SyncCommandDependencies } from './syncServices.js';

const TENANT = '00000000-0000-4000-8000-0000000000dd';
const SEARCH_KEY = 'sync-cmd-search-key-0123456789abcdef';
const OPENAI_KEY = 'sync-cmd-openai-key-0123456789abcdef';
const MOODLE_TOKEN = 'synccmdmoodletoken0123456789abcdef';

let site: FakeMoodleSite;
let search: FakeSearchService;
let directory: string;

const env = (overrides: Record<string, string> = {}): Record<string, string> => ({
  MOODLE_BASE_URL: 'https://ehub.example.test',
  MOODLE_TOKEN,
  AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
  AZURE_SEARCH_API_KEY: SEARCH_KEY,
  AZURE_SEARCH_VECTOR_DIMENSIONS: '8',
  AZURE_OPENAI_ENDPOINT: 'https://openai.example.test',
  AZURE_OPENAI_API_KEY: OPENAI_KEY,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
  AZURE_OPENAI_EMBEDDING_DIMENSIONS: '8',
  AZURE_TENANT_ID: TENANT,
  SYNC_COURSE_IDS: '12',
  ...overrides,
});

function searchClient(dimensions = 8): RestSearchIndexClient {
  return new RestSearchIndexClient({
    endpoint: 'https://search.example.test',
    indexName: 'ehub-course-content-v1',
    vectorDimensions: dimensions,
    semanticEnabled: true,
    authenticator: apiKeyAuthenticator(SEARCH_KEY),
    fetch: search.fetch,
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
  });
}

function dependencies(overrides: Partial<SyncCommandDependencies> = {}): SyncCommandDependencies {
  const embeddings = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: 8 });
  return {
    env: env(),
    cwd: directory,
    createAccess: (settings) => ({
      client: site.client,
      baseUrl: FIXTURE_BASE_URL,
      downloader: site.downloader,
      settings,
    }),
    createEmbedder: (settings): Promise<EmbeddingProvider> =>
      Promise.resolve(
        new AzureOpenAIEmbeddingProvider({
          endpoint: 'https://openai.example.test',
          deployment: 'embed',
          modelIdentifier: 'text-embedding-3-small',
          embeddingVersion: '1',
          dimensions: settings.AZURE_OPENAI_EMBEDDING_DIMENSIONS,
          sendDimensions: false,
          authenticator: apiKeyAuthenticator(OPENAI_KEY),
          batchSize: 16,
          maxBatchTokens: 100_000,
          maxInputTokens: 8191,
          maxConcurrency: 1,
          requestsPerMinute: 60_000,
          requestTimeoutMs: 5_000,
          retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
          fetch: embeddings.fetch,
        }),
      ),
    createSearch: () => Promise.resolve(searchClient()),
    ...overrides,
  };
}

async function run(
  name: string,
  args: string[],
  deps: SyncCommandDependencies = dependencies(),
): Promise<{ exitCode: number; stdout: string; logs: string }> {
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
  const command = createSyncCommands(deps)[name];
  if (command === undefined) {
    throw new Error(`no command ${name}`);
  }
  const exitCode = await command.run(context);
  return { exitCode, stdout: output.join('\n'), logs: logs.join('\n') };
}

beforeEach(async () => {
  site = new FakeMoodleSite();
  site.addCourse(12);
  site.setPage(12, 601, { html: pageHtml('Aftercare', ['Reapply sunscreen every two hours.']) });
  search = new FakeSearchService({ apiKey: SEARCH_KEY });
  directory = mkdtempSync(join(tmpdir(), 'ehub-sync-cmd-'));
  await searchClient().createOrUpdateIndex();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('sync commands', () => {
  it('registers every sync command', () => {
    expect(Object.keys(createSyncCommands(dependencies())).sort()).toEqual([
      'sync:course',
      'sync:full',
      'sync:incremental',
      'sync:reconcile',
      'sync:resource',
      'sync:retry-failed',
    ]);
  });

  it('runs a sync, stores state under SYNC_STATE_DIR and exits 0', async () => {
    const result = await run('sync:incremental', []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Processed 1 | skipped 0 | updated 1 | removed 0 | failed 0');
    expect(result.stdout).toContain('601:page');
    const again = await run('sync:incremental', ['--json']);
    expect(JSON.parse(again.stdout)).toMatchObject({ counts: { skipped: 1, updated: 0 } });
    for (const text of [result.stdout, result.logs]) {
      expect(text).not.toContain(MOODLE_TOKEN);
      expect(text).not.toContain(SEARCH_KEY);
      expect(text).not.toContain('Reapply sunscreen');
    }
  });

  it('exits 1 when the job completes with failures', async () => {
    site.downloadErrors.set(FakeMoodleSite.pagePath(601), new Error('boom'));
    const result = await run('sync:incremental', []);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('category=unexpected_error');
    expect(result.stdout).not.toContain('boom');
  });

  it('rejects options a command does not take and missing selections with exit 2', async () => {
    expect((await run('sync:full', ['--course-id', '12'])).stdout).toContain(
      'Unknown option: --course-id',
    );
    expect((await run('sync:full', ['--course-id', '12'])).exitCode).toBe(2);
    expect((await run('sync:reconcile', ['--force'])).exitCode).toBe(2);
    expect((await run('sync:course', [])).stdout).toContain('--course-id: is required.');
    expect(
      (await run('sync:resource', ['--course-id', '12', '--resource-id', 'nope'])).exitCode,
    ).toBe(2);
    const unselected = await run('sync:course', ['--course-id', '15']);
    expect(unselected.exitCode).toBe(2);
    expect(unselected.stdout).toContain('not in SYNC_COURSE_IDS');
  });

  it('reports setup problems before changing anything', async () => {
    const mismatch = await run(
      'sync:incremental',
      [],
      dependencies({ env: env({ AZURE_OPENAI_EMBEDDING_DIMENSIONS: '16' }) }),
    );
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stdout).toContain('dimension_mismatch');

    search = new FakeSearchService({ apiKey: SEARCH_KEY });
    const missing = await run('sync:incremental', ['--json']);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      status: 'error',
      error: { category: 'setup', code: 'index_missing' },
    });
    expect(site.downloads).toHaveLength(0);

    const config = await run(
      'sync:incremental',
      [],
      dependencies({ env: env({ AZURE_TENANT_ID: 'not-a-guid' }) }),
    );
    expect(config.exitCode).toBe(1);
    expect(config.stdout).toContain('AZURE_TENANT_ID');
  });

  it('refuses to start from a damaged state file', async () => {
    const folder = join(directory, '.ehub', 'sync-state', 'resources', TENANT);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '12.json'), '{"version":1,"resources":"broken"}');
    const result = await run('sync:incremental', []);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('state_corrupt');
  });

  it('accepts an injected state repository', async () => {
    const state = new InMemorySyncStateRepository();
    const result = await run(
      'sync:incremental',
      [],
      dependencies({ createStateRepository: () => state }),
    );
    expect(result.exitCode).toBe(0);
    expect(await state.listResources({ tenantId: TENANT })).toHaveLength(1);
  });
});
