import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type CommandContext } from '@ehub/shared';
import type { IndexValidationResult } from '@ehub/shared/search';
import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryIdentityMappingRepository } from '../authorization/identityMappingRepository.js';
import type { ChatModelProvider } from '../rag/chatModelProvider.js';
import type { QueryEmbedder, SearchPort } from '../retrieval/retrievalService.js';
import { TENANT_ID, TEST_DIMENSIONS } from '../retrieval/__fixtures__/corpus.js';
import { createPreflightCommand, type PreflightReport } from './preflightCommand.js';

/*
 * The preflight is the gate between a deployment and staff using it, so what it refuses matters
 * as much as what it allows. These tests cover both, and assert that nothing it prints could
 * leak a credential or an endpoint into a deployment log.
 */

const SEARCH_KEY = 'fake-search-admin-key-0123456789abcdef';
const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';
const MOODLE_TOKEN = 'fake-moodle-token-0123456789abcdef';
const BOT_SECRET = 'fake-bot-client-secret-value';
const API_CLIENT = '22222222-2222-4222-8222-222222222222';
const BOT_CLIENT = '33333333-3333-4333-8333-333333333333';
const CONNECTION_STRING =
  'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=https://example.in.applicationinsights.azure.com/';
const NOW = new Date('2026-11-12T10:00:00.000Z');

function baseEnv(stateDir: string): Record<string, string> {
  return {
    NODE_ENV: 'production',
    AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
    AZURE_SEARCH_VECTOR_DIMENSIONS: String(TEST_DIMENSIONS),
    AZURE_TENANT_ID: TENANT_ID,
    AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
    ENTRA_API_CLIENT_ID: API_CLIENT,
    ENTRA_API_APP_ID_URI: `api://${API_CLIENT}`,
    ENTRA_ALLOWED_CLIENT_APP_IDS: BOT_CLIENT,
    ENTRA_ALLOWED_TENANT_IDS: TENANT_ID,
    AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
    AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
    AZURE_OPENAI_API_KEY: OPENAI_KEY,
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
    AZURE_OPENAI_EMBEDDING_DIMENSIONS: String(TEST_DIMENSIONS),
    MOODLE_BASE_URL: 'https://ehub.example.test',
    MOODLE_TOKEN,
    MOODLE_TOKEN_EXPIRES_ON: '2027-06-30',
    SYNC_COURSE_IDS: '12,13',
    SYNC_STATE_DIR: stateDir,
    TEAMS_SSO_RESOURCE: `api://${API_CLIENT}`,
    TEAMS_BOT_CLIENT_ID: BOT_CLIENT,
    TEAMS_BOT_CLIENT_SECRET: BOT_SECRET,
    TEAMS_BOT_TENANT_ID: TENANT_ID,
    TEAMS_API_BASE_URL: 'https://api.example.test',
    TEAMS_ALLOWED_LINK_HOSTS: 'ehub.example.test',
    TEAMS_APP_ID: '44444444-4444-4444-8444-444444444444',
    TEAMS_DEVELOPER_NAME: 'Skin Renewal',
    TEAMS_WEBSITE_URL: 'https://example.test',
    TEAMS_PRIVACY_URL: 'https://example.test/privacy',
    TEAMS_TERMS_URL: 'https://example.test/terms',
    APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING,
  };
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function validation(overrides: Partial<IndexValidationResult> = {}): IndexValidationResult {
  return {
    indexName: 'ehub-course-content-v1',
    status: 'match',
    expectedSchemaVersion: 1,
    deployedSchemaVersion: 1,
    differences: [],
    ...overrides,
  };
}

interface RunOptions {
  readonly env?: (stateDir: string) => Record<string, string>;
  readonly searchStatus?: 'healthy' | 'unhealthy';
  readonly chatFails?: boolean;
  readonly moodleFails?: boolean;
  readonly index?: Partial<IndexValidationResult>;
  readonly indexThrows?: boolean;
  /** undefined: a credential that works. null: no token. 'throw': the request fails. */
  readonly credential?: null | 'throw';
  readonly json?: boolean;
  readonly args?: readonly string[];
}

async function run(options: RunOptions = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'ehub-preflight-'));
  directories.push(stateDir);
  const env = (options.env ?? baseEnv)(stateDir);
  const output: string[] = [];
  const logs: string[] = [];
  const context: CommandContext = {
    args: [...(options.args ?? (options.json === false ? [] : ['--json']))],
    logger: createLogger({ service: 'test', level: 'trace', sink: { write: (l) => logs.push(l) } }),
    stdout: (text) => output.push(text),
  };
  const failure = (category: string) =>
    Promise.reject(
      Object.assign(new Error(`https://ehub.example.test/?wstoken=${MOODLE_TOKEN}`), { category }),
    );
  const command = createPreflightCommand({
    env,
    createSearch: () =>
      Promise.resolve({
        healthCheck: () => Promise.resolve({ status: options.searchStatus ?? 'healthy' }),
        validateIndexSchema: () =>
          options.indexThrows === true
            ? Promise.reject(new Error('unreadable'))
            : Promise.resolve(validation(options.index)),
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
    createCredential: () =>
      options.credential === 'throw'
        ? Promise.reject(new Error('no identity'))
        : Promise.resolve({
            getToken: () =>
              Promise.resolve(
                options.credential === null
                  ? null
                  : { token: 'fake-identity-token', expiresOnTimestamp: NOW.getTime() + 600_000 },
              ),
          }),
    now: () => NOW,
  });
  const exitCode = await command.run(context);
  const stdout = output.join('\n');
  for (const text of [stdout, logs.join('\n')]) {
    for (const secret of [SEARCH_KEY, OPENAI_KEY, MOODLE_TOKEN, BOT_SECRET, 'InstrumentationKey']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('search.example.test');
    expect(text).not.toContain('openai.azure.com');
  }
  return {
    exitCode,
    stdout,
    report: options.json === false ? undefined : (JSON.parse(stdout) as PreflightReport),
  };
}

function check(report: PreflightReport | undefined, name: string) {
  return report?.live.find((entry) => entry.name === name);
}

describe('pnpm preflight: a deployment that is ready', () => {
  it('passes with every live check up and the index schema matching', async () => {
    const { exitCode, report } = await run();
    expect(exitCode).toBe(0);
    expect(report?.status).toBe('pass');
    expect(report?.configuration.findings).toEqual([]);
    expect(report?.live.map((entry) => [entry.name, entry.status])).toEqual([
      ['managed_identity', 'pass'],
      ['search', 'pass'],
      ['embedding', 'pass'],
      ['chat', 'pass'],
      ['moodle', 'pass'],
      ['state_store', 'pass'],
      ['sync_state', 'pass'],
    ]);
    expect(report?.indexSchema).toMatchObject({ status: 'match', differences: 0 });
  });

  it('accepts an index with compatible pending changes', async () => {
    const { exitCode, report } = await run({ index: { status: 'compatible-changes' } });
    expect(exitCode).toBe(0);
    expect(report?.status).toBe('pass');
  });

  it('prints a readable report without --json', async () => {
    const { stdout, exitCode } = await run({ json: false });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Preflight: PASS.');
    expect(stdout).toContain('managed_identity');
    expect(stdout).toContain('index schema');
  });
});

describe('pnpm preflight: live failures', () => {
  it.each([
    ['search is unhealthy', { searchStatus: 'unhealthy' as const }, 'search', 'unhealthy'],
    ['the chat model refuses the credential', { chatFails: true }, 'chat', 'authentication'],
    ['Moodle is unreachable', { moodleFails: true }, 'moodle', 'network'],
  ])('fails when %s, naming only the category', async (_label, options, name, detail) => {
    const { exitCode, report } = await run(options);
    expect(exitCode).toBe(1);
    expect(report?.status).toBe('fail');
    expect(check(report, name)).toMatchObject({ status: 'fail', detail });
  });

  it('fails when the managed identity cannot get a token', async () => {
    const { exitCode, report } = await run({ credential: 'throw' });
    expect(exitCode).toBe(1);
    expect(check(report, 'managed_identity')).toMatchObject({
      status: 'fail',
      detail: 'token_request_failed',
    });
  });

  it('fails when the credential returns no token at all', async () => {
    const { report } = await run({ credential: null });
    expect(check(report, 'managed_identity')).toMatchObject({ status: 'fail', detail: 'no_token' });
  });

  it('skips the identity check when search uses an API key, and says so', async () => {
    const { report } = await run({
      env: (stateDir) => ({ ...baseEnv(stateDir), AZURE_SEARCH_API_KEY: SEARCH_KEY }),
    });
    expect(check(report, 'managed_identity')).toMatchObject({
      status: 'skipped',
      detail: 'api_key_authentication',
    });
  });
});

describe('pnpm preflight: the index schema', () => {
  it.each([['missing'], ['incompatible']] as const)('fails an index that is %s', async (status) => {
    const { exitCode, report } = await run({ index: { status } });
    expect(exitCode).toBe(1);
    expect(report?.indexSchema).toMatchObject({ status });
  });

  it('fails, rather than passing, when the index cannot be read at all', async () => {
    const { exitCode, report } = await run({ indexThrows: true });
    expect(exitCode).toBe(1);
    expect(report?.indexSchema).toEqual({ status: 'not_checked', reason: 'index_unreadable' });
  });
});

describe('pnpm preflight --static', () => {
  it('checks configuration only, contacting nothing', async () => {
    const { exitCode, report } = await run({ args: ['--static', '--json'], moodleFails: true });
    expect(exitCode).toBe(0);
    expect(report?.live).toEqual([]);
    expect(report?.indexSchema).toEqual({ status: 'not_checked', reason: 'static_only' });
  });

  it('still fails on a configuration problem', async () => {
    const { exitCode } = await run({
      args: ['--static', '--json'],
      env: (stateDir) => ({ ...baseEnv(stateDir), API_DEV_MOCK_IDENTITY: 'true' }),
    });
    expect(exitCode).toBe(1);
  });

  it('says in its text output that nothing live was checked', async () => {
    const { stdout } = await run({ args: ['--static'], json: false });
    expect(stdout).toContain('configuration only');
  });
});

describe('pnpm preflight --scope', () => {
  it('passes the release scope on a file holding no secrets at all', async () => {
    const { exitCode, report } = await run({
      args: ['--static', '--scope', 'release', '--json'],
      env: () => ({
        NODE_ENV: 'production',
        ENTRA_API_CLIENT_ID: API_CLIENT,
        ENTRA_API_APP_ID_URI: `api://${API_CLIENT}`,
        ENTRA_ALLOWED_CLIENT_APP_IDS: BOT_CLIENT,
        TEAMS_SSO_RESOURCE: `api://${API_CLIENT}`,
        TEAMS_BOT_CLIENT_ID: BOT_CLIENT,
        TEAMS_APP_ID: '44444444-4444-4444-8444-444444444444',
        TEAMS_DEVELOPER_NAME: 'Skin Renewal',
        TEAMS_WEBSITE_URL: 'https://example.test',
        TEAMS_PRIVACY_URL: 'https://example.test/privacy',
        TEAMS_TERMS_URL: 'https://example.test/terms',
      }),
    });
    expect(exitCode).toBe(0);
    expect(report?.configuration.findings).toEqual([]);
  });

  it('still catches a wrong audience and an auth bypass in the release scope', async () => {
    const { exitCode, report } = await run({
      args: ['--static', '--scope', 'release', '--json'],
      env: (stateDir) => ({
        ...baseEnv(stateDir),
        TEAMS_SSO_RESOURCE: 'api://someone-else',
        TEAMS_DEV_MOCK_IDENTITY: 'true',
      }),
    });
    expect(exitCode).toBe(1);
    const found = report?.configuration.findings.map((finding) => finding.id) ?? [];
    expect(found).toContain('entra.ssoResource');
    expect(found).toContain('pilot.TEAMS_DEV_MOCK_IDENTITY');
  });

  it('refuses an unknown scope rather than guessing', async () => {
    await expect(run({ args: ['--static', '--scope', 'whatever', '--json'] })).rejects.toThrow();
  });
});

describe('pnpm preflight: configuration and pilot controls', () => {
  it('fails a deployment with mock identity left on, even when every service is up', async () => {
    const { exitCode, report } = await run({
      env: (stateDir) => ({ ...baseEnv(stateDir), API_DEV_MOCK_IDENTITY: 'true' }),
    });
    expect(exitCode).toBe(1);
    expect(report?.configuration.findings.map((finding) => finding.id)).toContain(
      'pilot.API_DEV_MOCK_IDENTITY',
    );
    // The services are fine: this is a configuration refusal, and the report shows that.
    expect(check(report, 'search')).toMatchObject({ status: 'pass' });
  });

  it('fails and records that nothing live ran when configuration is incomplete', async () => {
    const { exitCode, report } = await run({
      env: (stateDir) => {
        const env = { ...baseEnv(stateDir) };
        delete env['AZURE_OPENAI_CHAT_DEPLOYMENT'];
        return env;
      },
    });
    expect(exitCode).toBe(1);
    expect(check(report, 'live_checks')).toMatchObject({
      status: 'fail',
      detail: 'configuration_incomplete',
    });
    expect(report?.indexSchema).toMatchObject({ status: 'not_checked' });
  });
});
