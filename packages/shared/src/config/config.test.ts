import { afterEach, describe, expect, it } from 'vitest';

import { clearRegisteredSecretValues, redactString } from '../logging/redaction.js';
import {
  ConfigValidationError,
  cleanEnvironment,
  describeConfig,
  getConfigFeatureStatus,
  loadConfig,
} from './load.js';
import {
  applicationConfigSchema,
  azureIdentityConfigSchema,
  azureSearchConfigSchema,
  moodleConfigSchema,
  runtimeConfigSchema,
  syncConfigSchema,
} from './schema.js';

// Obviously fake values; none of these is a real credential or endpoint.
const FAKE_MOODLE_TOKEN = 'fake-moodle-token-0123456789abcdef';
const FAKE_CLIENT_SECRET = 'fake-client-secret-value';
const FAKE_SEARCH_KEY = 'fake-search-admin-key-0123456789';

const validEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'debug',
  PORT: '3978',
  MOODLE_BASE_URL: 'https://ehub.example.test',
  MOODLE_TOKEN: FAKE_MOODLE_TOKEN,
  AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
  AZURE_SEARCH_INDEX_NAME: 'ehub-course-content-v1',
  AZURE_OPENAI_ENDPOINT: 'https://openai.example.test',
  AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat-deployment',
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embedding-deployment',
  AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  AZURE_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
  AZURE_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  APPLICATIONINSIGHTS_CONNECTION_STRING:
    'InstrumentationKey=00000000-0000-4000-8000-000000000003;IngestionEndpoint=https://example.test/',
} as const;

function expectIssues(fn: () => unknown): ConfigValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return error as ConfigValidationError;
  }
  throw new Error('Expected configuration validation to fail.');
}

afterEach(() => {
  clearRegisteredSecretValues();
});

describe('runtime configuration', () => {
  it('applies defaults when variables are absent', () => {
    expect(loadConfig(runtimeConfigSchema, {})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 3000,
    });
  });

  it('treats empty values copied from .env.example as unset', () => {
    expect(loadConfig(runtimeConfigSchema, { NODE_ENV: '', LOG_LEVEL: '  ', PORT: '' })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 3000,
    });
    expect(cleanEnvironment({ A: '', B: ' ', C: 'x', D: undefined })).toEqual({ C: 'x' });
  });

  it('coerces PORT to an integer', () => {
    expect(loadConfig(runtimeConfigSchema, { PORT: '8080' }).PORT).toBe(8080);
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '3.5'],
  ])('rejects %s=%s', (variable, value) => {
    const error = expectIssues(() => loadConfig(runtimeConfigSchema, { [variable]: value }));
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
  });

  it('does not carry unrelated environment variables into the configuration', () => {
    const config = loadConfig(runtimeConfigSchema, { PATH: '/usr/bin', HOME: '/root' });
    expect(Object.keys(config).sort()).toEqual(['LOG_LEVEL', 'NODE_ENV', 'PORT']);
  });
});

describe('application configuration', () => {
  it('accepts a complete valid environment', () => {
    const config = loadConfig(applicationConfigSchema, validEnv);
    expect(config.MOODLE_TOKEN).toBe(FAKE_MOODLE_TOKEN);
    expect(config.PORT).toBe(3978);
  });

  it('reports every missing required variable by name', () => {
    const error = expectIssues(() => loadConfig(applicationConfigSchema, {}));
    expect(error.issues.map((issue) => issue.variable).sort()).toEqual(
      [
        'AZURE_CLIENT_ID',
        'AZURE_OPENAI_CHAT_DEPLOYMENT',
        'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
        'AZURE_OPENAI_ENDPOINT',
        'AZURE_SEARCH_ENDPOINT',
        'AZURE_TENANT_ID',
        'MOODLE_BASE_URL',
        'MOODLE_TOKEN',
      ].sort(),
    );
    expect(error.issues.every((issue) => issue.message === 'Required.')).toBe(true);
  });

  it('allows the client secret and Application Insights to be omitted (Managed Identity)', () => {
    const managedIdentityEnv: Record<string, string> = { ...validEnv };
    delete managedIdentityEnv['AZURE_CLIENT_SECRET'];
    delete managedIdentityEnv['APPLICATIONINSIGHTS_CONNECTION_STRING'];
    const config = loadConfig(applicationConfigSchema, managedIdentityEnv);
    expect(config.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(config.APPLICATIONINSIGHTS_CONNECTION_STRING).toBeUndefined();
  });

  it.each([
    ['MOODLE_BASE_URL', 'not a url'],
    ['MOODLE_BASE_URL', 'ftp://ehub.example.test'],
    ['MOODLE_BASE_URL', 'https://user:pass@ehub.example.test'],
    ['MOODLE_BASE_URL', 'https://ehub.example.test/?wstoken=abc'],
    ['MOODLE_BASE_URL', 'https://ehub.example.test/#frag'],
    ['AZURE_SEARCH_ENDPOINT', 'http://search.example.test'],
    ['AZURE_OPENAI_ENDPOINT', 'http://openai.example.test'],
    ['AZURE_SEARCH_INDEX_NAME', 'Uppercase-Index'],
    ['AZURE_SEARCH_INDEX_NAME', 'double--dash'],
    ['AZURE_SEARCH_INDEX_NAME', '-leading'],
    ['AZURE_SEARCH_INDEX_NAME', 'x'],
    ['AZURE_OPENAI_CHAT_DEPLOYMENT', 'has space'],
    ['AZURE_TENANT_ID', 'not-a-guid'],
    ['AZURE_CLIENT_ID', 'contoso.onmicrosoft.com'],
    ['MOODLE_TOKEN', 'short'],
    ['APPLICATIONINSIGHTS_CONNECTION_STRING', 'IngestionEndpoint=https://x.test/'],
  ])('rejects invalid %s', (variable, value) => {
    const error = expectIssues(() =>
      loadConfig(applicationConfigSchema, { ...validEnv, [variable]: value }),
    );
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
  });

  it('accepts http Moodle in development but requires https in production', () => {
    const httpMoodle = { ...validEnv, MOODLE_BASE_URL: 'http://localhost:8080' };
    expect(loadConfig(applicationConfigSchema, httpMoodle).MOODLE_BASE_URL).toBe(
      'http://localhost:8080',
    );

    const error = expectIssues(() =>
      loadConfig(applicationConfigSchema, { ...httpMoodle, NODE_ENV: 'production' }),
    );
    expect(error.issues).toEqual([
      { variable: 'MOODLE_BASE_URL', message: 'Must use https in production.' },
    ]);
  });

  it('enforces the production https rule in feature schemas too', () => {
    const error = expectIssues(() =>
      loadConfig(moodleConfigSchema, {
        NODE_ENV: 'production',
        MOODLE_BASE_URL: 'http://ehub.example.test',
        MOODLE_TOKEN: FAKE_MOODLE_TOKEN,
      }),
    );
    expect(error.issues.map((issue) => issue.variable)).toEqual(['MOODLE_BASE_URL']);
  });

  it('never echoes secret values in validation errors', () => {
    const badToken = 'fake-but-invalid token-with-space-0123456789';
    const badSecret = 'x';
    const error = expectIssues(() =>
      loadConfig(applicationConfigSchema, {
        ...validEnv,
        MOODLE_TOKEN: badToken,
        AZURE_CLIENT_SECRET: badSecret,
        MOODLE_BASE_URL: `https://ehub.example.test/?wstoken=${FAKE_MOODLE_TOKEN}`,
      }),
    );

    const rendered = `${error.message}\n${JSON.stringify(error.issues)}\n${String(error.stack)}`;
    expect(rendered).not.toContain(badToken);
    expect(rendered).not.toContain(FAKE_MOODLE_TOKEN);
    expect(error.issues.map((issue) => issue.variable).sort()).toEqual([
      'AZURE_CLIENT_SECRET',
      'MOODLE_BASE_URL',
      'MOODLE_TOKEN',
    ]);
  });

  it('registers loaded secret values for log redaction', () => {
    loadConfig(applicationConfigSchema, validEnv);
    expect(redactString(`leak ${FAKE_MOODLE_TOKEN} and ${FAKE_CLIENT_SECRET}`)).toBe(
      'leak [REDACTED] and [REDACTED]',
    );
  });

  it('registers secret values even when validation fails', () => {
    const malformed = 'malformed token value 123456';
    expectIssues(() => loadConfig(moodleConfigSchema, { MOODLE_TOKEN: malformed }));
    expect(redactString(malformed)).toBe('[REDACTED]');
  });
});

describe('describeConfig', () => {
  it('masks secret values and keeps non-secret settings', () => {
    const description = describeConfig(loadConfig(applicationConfigSchema, validEnv));
    expect(description['MOODLE_TOKEN']).toBe('[configured]');
    expect(description['AZURE_CLIENT_SECRET']).toBe('[configured]');
    expect(description['APPLICATIONINSIGHTS_CONNECTION_STRING']).toBe('[configured]');
    expect(description['MOODLE_BASE_URL']).toBe('https://ehub.example.test');
    expect(description['PORT']).toBe(3978);
    expect(JSON.stringify(description)).not.toContain(FAKE_MOODLE_TOKEN);
  });

  it('marks optional secrets that are absent', () => {
    expect(describeConfig({ AZURE_CLIENT_SECRET: undefined })['AZURE_CLIENT_SECRET']).toBe(
      '[not set]',
    );
  });
});

describe('getConfigFeatureStatus', () => {
  it('reports a fully configured feature as valid', () => {
    expect(getConfigFeatureStatus('azureSearch', validEnv)).toEqual({
      feature: 'azureSearch',
      state: 'valid',
      anyVariableSet: true,
      problems: [],
    });
  });

  it('distinguishes an absent feature from a partially configured one', () => {
    expect(getConfigFeatureStatus('moodle', {}).state).toBe('missing');

    const partial = getConfigFeatureStatus('moodle', {
      MOODLE_BASE_URL: 'https://ehub.example.test',
    });
    expect(partial.state).toBe('invalid');
    expect(partial.problems).toEqual([{ variable: 'MOODLE_TOKEN', message: 'Required.' }]);
  });

  it('reports invalid runtime settings that affect every feature', () => {
    const status = getConfigFeatureStatus('azureSearch', {
      ...validEnv,
      PORT: 'not-a-port',
    });
    expect(status.state).toBe('invalid');
    expect(status.problems.map((problem) => problem.variable)).toEqual(['PORT']);
  });

  it('treats a feature with only optional variables as valid when absent', () => {
    expect(getConfigFeatureStatus('observability', {}).state).toBe('valid');
  });

  it('applies Azure AI Search defaults and parses the semantic flag', () => {
    const config = loadConfig(azureSearchConfigSchema, {
      AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
    });
    expect(config).toMatchObject({
      AZURE_SEARCH_INDEX_NAME: 'ehub-course-content-v1',
      AZURE_SEARCH_VECTOR_DIMENSIONS: 1536,
      AZURE_SEARCH_SEMANTIC_ENABLED: true,
      AZURE_SEARCH_BATCH_SIZE: 500,
      AZURE_SEARCH_MAX_RETRIES: 3,
    });
    expect(
      loadConfig(azureSearchConfigSchema, {
        AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
        AZURE_SEARCH_SEMANTIC_ENABLED: 'false',
      }).AZURE_SEARCH_SEMANTIC_ENABLED,
    ).toBe(false);
  });

  it('rejects invalid Azure AI Search settings without echoing the key', () => {
    const error = expectIssues(() =>
      loadConfig(azureSearchConfigSchema, {
        AZURE_SEARCH_ENDPOINT: 'http://search.example.test',
        AZURE_SEARCH_INDEX_NAME: 'Bad_Name',
        AZURE_SEARCH_API_KEY: `${FAKE_SEARCH_KEY} x`,
        AZURE_SEARCH_VECTOR_DIMENSIONS: '0',
        AZURE_SEARCH_SEMANTIC_ENABLED: 'yes',
        AZURE_SEARCH_BATCH_SIZE: '1001',
      }),
    );
    expect(error.issues.map((issue) => issue.variable).sort()).toEqual([
      'AZURE_SEARCH_API_KEY',
      'AZURE_SEARCH_BATCH_SIZE',
      'AZURE_SEARCH_ENDPOINT',
      'AZURE_SEARCH_INDEX_NAME',
      'AZURE_SEARCH_SEMANTIC_ENABLED',
      'AZURE_SEARCH_VECTOR_DIMENSIONS',
    ]);
    expect(error.message).not.toContain(FAKE_SEARCH_KEY);
  });

  it('treats the search API key as a secret', () => {
    const config = loadConfig(azureSearchConfigSchema, {
      AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
      AZURE_SEARCH_API_KEY: FAKE_SEARCH_KEY,
    });
    expect(describeConfig(config)['AZURE_SEARCH_API_KEY']).not.toContain(FAKE_SEARCH_KEY);
    expect(redactString(`key=${FAKE_SEARCH_KEY}`)).not.toContain(FAKE_SEARCH_KEY);
  });

  it('works for each feature schema used by the applications', () => {
    expect(loadConfig(azureSearchConfigSchema, validEnv).AZURE_SEARCH_INDEX_NAME).toBe(
      'ehub-course-content-v1',
    );
    expect(loadConfig(azureIdentityConfigSchema, validEnv).AZURE_TENANT_ID).toBe(
      validEnv.AZURE_TENANT_ID,
    );
  });
});

describe('sync configuration', () => {
  const tenant = { AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000001' };

  it('parses, de-duplicates and sorts SYNC_COURSE_IDS and applies defaults', () => {
    const config = loadConfig(syncConfigSchema, { ...tenant, SYNC_COURSE_IDS: ' 15, 12,15 ,' });
    expect(config).toMatchObject({
      SYNC_COURSE_IDS: [12, 15],
      SYNC_ALL_COURSES: false,
      SYNC_INCLUDE_HIDDEN: false,
      SYNC_STATE_DIR: '.ehub/sync-state',
      SYNC_MAX_ATTEMPTS: 5,
      SYNC_MAX_DELETE_FRACTION: 0.5,
    });
    // Empty values (copied from .env.example) mean unset.
    expect(
      loadConfig(syncConfigSchema, { ...tenant, SYNC_COURSE_IDS: '' }).SYNC_COURSE_IDS,
    ).toBeUndefined();
  });

  it('rejects malformed or conflicting selections and settings', () => {
    for (const env of [
      { SYNC_COURSE_IDS: '12,abc' },
      { SYNC_COURSE_IDS: '0' },
      { SYNC_COURSE_IDS: '12', SYNC_ALL_COURSES: 'true' },
      { SYNC_MAX_DELETE_FRACTION: '1.5' },
      { SYNC_RETRY_BASE_DELAY_MS: '5000', SYNC_RETRY_MAX_DELAY_MS: '1000' },
      { SYNC_LEASE_TTL_MS: '1000' },
    ]) {
      expect(() => loadConfig(syncConfigSchema, { ...tenant, ...env })).toThrow(
        ConfigValidationError,
      );
    }
    expect(() => loadConfig(syncConfigSchema, { SYNC_ALL_COURSES: 'true' })).toThrow(
      ConfigValidationError,
    );
  });
});
