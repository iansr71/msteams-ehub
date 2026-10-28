import { createLogger, type CommandContext } from '@ehub/shared';
import {
  RestSearchIndexClient,
  apiKeyAuthenticator,
  type SearchClientSettings,
} from '@ehub/shared/search';
import { describe, expect, it } from 'vitest';

import { FakeSearchService } from '../../../../packages/shared/src/search/__fixtures__/fakeSearchService.js';
import { createSearchCommands } from './searchCommands.js';

const API_KEY = 'fake-search-admin-key-0123456789abcdef';
const env = {
  AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
  AZURE_SEARCH_API_KEY: API_KEY,
  AZURE_SEARCH_VECTOR_DIMENSIONS: '8',
};

async function run(
  command: 'search:create-index' | 'search:validate-index' | 'search:health',
  args: string[],
  options: { service?: FakeSearchService; env?: Record<string, string> } = {},
) {
  const service = options.service ?? new FakeSearchService({ apiKey: API_KEY });
  const output: string[] = [];
  const logs: string[] = [];
  let settingsSeen: SearchClientSettings | undefined;
  const context: CommandContext = {
    args,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logs.push(line) },
    }),
    stdout: (text) => output.push(text),
  };
  const commands = createSearchCommands({
    env: options.env ?? env,
    createClient: (settings, logger) => {
      settingsSeen = settings;
      return Promise.resolve(
        new RestSearchIndexClient({
          endpoint: settings.AZURE_SEARCH_ENDPOINT,
          indexName: settings.AZURE_SEARCH_INDEX_NAME,
          vectorDimensions: settings.AZURE_SEARCH_VECTOR_DIMENSIONS,
          semanticEnabled: settings.AZURE_SEARCH_SEMANTIC_ENABLED,
          authenticator: apiKeyAuthenticator(settings.AZURE_SEARCH_API_KEY ?? 'missing-key-value'),
          fetch: service.fetch,
          logger,
          sleep: () => Promise.resolve(),
        }),
      );
    },
  });
  const definition = commands[command];
  if (definition === undefined) {
    throw new Error(`no command ${command}`);
  }
  const exitCode = await definition.run(context);
  const stdout = output.join('\n');
  const logText = logs.join('\n');
  expect(stdout).not.toContain(API_KEY);
  expect(logText).not.toContain(API_KEY);
  return { exitCode, stdout, logText, service, settingsSeen };
}

describe('search:* commands', () => {
  it('create-index creates the index, then reports it unchanged', async () => {
    const first = await run('search:create-index', []);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe('Index ehub-course-content-v1 created.');
    expect(first.settingsSeen?.AZURE_SEARCH_INDEX_NAME).toBe('ehub-course-content-v1');

    const second = await run('search:create-index', ['--json'], { service: first.service });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      indexName: 'ehub-course-content-v1',
      outcome: 'unchanged',
      validation: { status: 'match' },
    });
  });

  it('validate-index fails for a missing index and passes once created', async () => {
    const missing = await run('search:validate-index', []);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('MISSING (run search:create-index)');

    await run('search:create-index', [], { service: missing.service });
    const valid = await run('search:validate-index', ['--json'], { service: missing.service });
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ status: 'match', expectedSchemaVersion: 1 });
  });

  it('refuses to change an incompatible index and prints migration guidance', async () => {
    const created = await run('search:create-index', []);
    const changed = await run('search:create-index', ['--apply-compatible-changes'], {
      service: created.service,
      env: { ...env, AZURE_SEARCH_VECTOR_DIMENSIONS: '16' },
    });
    expect(changed.exitCode).toBe(1);
    expect(changed.stdout).toContain('NOT changed: the schema needs a migration');
    expect(changed.stdout).toContain('[INCOMPATIBLE] Field contentVector: dimensions is 8');
    expect(changed.stdout).toContain('Do not delete it');
    expect(changed.service.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('applies compatible changes only with the explicit flag', async () => {
    const created = await run('search:create-index', [], {
      env: { ...env, AZURE_SEARCH_SEMANTIC_ENABLED: 'false' },
    });
    const pending = await run('search:create-index', [], { service: created.service });
    expect(pending.exitCode).toBe(1);
    expect(pending.stdout).toContain('NOT applied');
    const applied = await run('search:create-index', ['--apply-compatible-changes'], {
      service: created.service,
    });
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain('updated in place');
  });

  it('health reports counts only', async () => {
    const created = await run('search:create-index', []);
    const health = await run('search:health', [], { service: created.service });
    expect(health.exitCode).toBe(0);
    expect(health.stdout).toContain('Azure AI Search: HEALTHY');
    expect(health.stdout).toContain('Authentication: API key');
    expect(health.stdout).toContain('Documents: 0');

    const missing = await run('search:health', ['--json']);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      status: 'unhealthy',
      index: { exists: false },
    });
  });

  it('reports missing configuration by variable name', async () => {
    const result = await run('search:health', [], { env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('AZURE_SEARCH_ENDPOINT: Required.');
  });

  it('explains authentication failures without revealing the key', async () => {
    const service = new FakeSearchService({ apiKey: 'a-different-key-0123456789' });
    const result = await run('search:validate-index', [], { service });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Search index validation failed: authentication');
    expect(result.stdout).toContain('Hint: Locally, check AZURE_SEARCH_API_KEY');
  });

  it('rejects unknown options with the usage exit code', async () => {
    const result = await run('search:create-index', ['--force']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('Unknown option: --force');
    expect(result.service.requests).toHaveLength(0);
  });
});
