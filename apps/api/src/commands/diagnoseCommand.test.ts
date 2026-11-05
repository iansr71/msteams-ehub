import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type CommandContext } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryIdentityMappingRepository } from '../authorization/identityMappingRepository.js';
import type { ChatModelProvider } from '../rag/chatModelProvider.js';
import type { QueryEmbedder, SearchPort } from '../retrieval/retrievalService.js';
import { TENANT_ID, TEST_DIMENSIONS } from '../retrieval/__fixtures__/corpus.js';
import { createDiagnoseCommand, type DiagnosticReport } from './diagnoseCommand.js';

const SEARCH_KEY = 'fake-search-admin-key-0123456789abcdef';
const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';
const MOODLE_TOKEN = 'fake-moodle-token-0123456789abcdef';
const CONNECTION_STRING =
  'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=https://example.in.applicationinsights.azure.com/';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function baseEnv(stateDir: string): Record<string, string> {
  return {
    AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
    AZURE_SEARCH_API_KEY: SEARCH_KEY,
    AZURE_SEARCH_VECTOR_DIMENSIONS: String(TEST_DIMENSIONS),
    AZURE_TENANT_ID: TENANT_ID,
    AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
    ENTRA_API_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    ENTRA_ALLOWED_CLIENT_APP_IDS: '33333333-3333-4333-8333-333333333333',
    AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
    AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
    AZURE_OPENAI_API_KEY: OPENAI_KEY,
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
    AZURE_OPENAI_EMBEDDING_DIMENSIONS: String(TEST_DIMENSIONS),
    MOODLE_BASE_URL: 'https://ehub.example.test',
    MOODLE_TOKEN,
    SYNC_STATE_DIR: stateDir,
    APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING,
  };
}

async function run(
  options: {
    env?: (stateDir: string) => Record<string, string>;
    searchStatus?: 'healthy' | 'unhealthy';
    chatFails?: boolean;
    moodleFails?: boolean;
  } = {},
) {
  const stateDir = await mkdtemp(join(tmpdir(), 'ehub-diagnose-'));
  directories.push(stateDir);
  const env = (options.env ?? baseEnv)(stateDir);
  const output: string[] = [];
  const logs: string[] = [];
  const context: CommandContext = {
    args: [],
    logger: createLogger({ service: 'test', level: 'trace', sink: { write: (l) => logs.push(l) } }),
    stdout: (text) => output.push(text),
  };
  const failure = (category: string) =>
    Promise.reject(
      Object.assign(new Error(`https://ehub.example.test/?wstoken=${MOODLE_TOKEN}`), { category }),
    );
  const command = createDiagnoseCommand({
    env,
    createSearch: () =>
      Promise.resolve({
        healthCheck: () => Promise.resolve({ status: options.searchStatus ?? 'healthy' }),
      } as unknown as SearchPort),
    createEmbedder: () =>
      Promise.resolve({
        healthCheck: () => Promise.resolve({ status: 'healthy' }),
        embedQuery: () => Promise.resolve([]),
      } as unknown as QueryEmbedder),
    createChat: () =>
      Promise.resolve({
        complete: () =>
          options.chatFails === true ? failure('authentication') : Promise.resolve({}),
        getModelName: () => 'gpt-test',
      } as unknown as ChatModelProvider),
    moodle: {
      getUsersByField: () => Promise.resolve([]),
      getUserCourses: () => Promise.resolve([]),
      getSiteInfo: () => (options.moodleFails === true ? failure('network') : Promise.resolve({})),
    } as never,
    identityRepository: new InMemoryIdentityMappingRepository(),
    now: () => new Date('2026-11-05T10:00:00.000Z'),
  });
  const exitCode = await command.run(context);
  const stdout = output.join('\n');
  for (const text of [stdout, logs.join('\n')]) {
    for (const secret of [SEARCH_KEY, OPENAI_KEY, MOODLE_TOKEN, 'InstrumentationKey']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('search.example.test');
    expect(text).not.toContain('openai.azure.com');
  }
  return { exitCode, report: JSON.parse(stdout) as DiagnosticReport };
}

describe('pnpm diagnose', () => {
  it('passes when configuration and every dependency are healthy', async () => {
    const { exitCode, report } = await run();
    expect(exitCode).toBe(0);
    expect(report.status).toBe('pass');
    expect(report.dependencies.map((d) => [d.name, d.required, d.status])).toEqual([
      ['search', true, 'up'],
      ['embedding', true, 'up'],
      ['chat', true, 'up'],
      ['moodle', true, 'up'],
      ['state_store', true, 'up'],
    ]);
    expect(report.sync).toMatchObject({ status: 'ok', lagSeconds: null });
    expect(report.telemetry).toEqual({ applicationInsights: 'configured' });
    expect(report.skipped).toEqual([]);
  });

  it.each([
    ['search is unhealthy', { searchStatus: 'unhealthy' as const }, 'search', 'unhealthy'],
    ['the chat model refuses the credential', { chatFails: true }, 'chat', 'authentication'],
    ['Moodle is unreachable', { moodleFails: true }, 'moodle', 'network'],
  ])('fails when %s, naming only the category', async (_label, options, name, category) => {
    const { exitCode, report } = await run(options);
    expect(exitCode).toBe(1);
    expect(report.status).toBe('fail');
    expect(report.dependencies.find((d) => d.name === name)).toMatchObject({
      status: 'down',
      category,
    });
  });

  it('skips live checks and fails when configuration is incomplete', async () => {
    const { exitCode, report } = await run({
      env: (stateDir) => {
        const env = baseEnv(stateDir);
        delete env['AZURE_OPENAI_CHAT_DEPLOYMENT'];
        return env;
      },
    });
    expect(exitCode).toBe(1);
    expect(report.dependencies).toEqual([]);
    expect(report.skipped).toEqual(['live checks skipped: configuration is incomplete']);
  });

  it('reports an invalid Application Insights connection string without printing it', async () => {
    const { report } = await run({
      env: (stateDir) => ({
        ...baseEnv(stateDir),
        APPLICATIONINSIGHTS_CONNECTION_STRING: 'not-a-connection-string',
      }),
    });
    expect(report.telemetry).toEqual({ applicationInsights: 'invalid' });
    expect(JSON.stringify(report)).not.toContain('not-a-connection-string');
  });
});
