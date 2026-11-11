import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FEATURES,
  applicationConfigSchema,
  cleanEnvironment,
  type ConfigFeature,
} from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_ENV } from '../../infrastructure/scripts/validate-bicep.mjs';

/*
 * Repository checks for infrastructure/:
 * - the Bicep templates lint and build (when the Bicep CLI is installed);
 * - the settings main.bicep gives each service satisfy that service's production configuration;
 * - nothing tenant-specific or secret is committed, and no secret is a deployment output.
 */

const repo = fileURLToPath(new URL('../../', import.meta.url));
const bicepDir = join(repo, 'infrastructure', 'bicep');
const main = readFileSync(join(bicepDir, 'main.bicep'), 'utf8');

function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

function hasBicep(): boolean {
  for (const command of [[process.env['EHUB_BICEP'] ?? ''], ['bicep'], ['az', 'bicep']]) {
    if (command[0] && spawnSync(command[0], [...command.slice(1), '--version']).status === 0)
      return true;
  }
  return false;
}

describe.skipIf(!hasBicep())('Bicep templates (Bicep CLI installed)', () => {
  it('lint without warnings, build, and build every parameter file for both stages', () => {
    const result = spawnSync(
      process.execPath,
      [join(repo, 'infrastructure', 'scripts', 'validate-bicep.mjs'), '--require-bicep'],
      {
        encoding: 'utf8',
      },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Bicep templates and parameter files are valid.');
    expect(result.status).toBe(0);
  }, 300_000);

  it('fails on a lint warning and on a type error, not only on build errors', () => {
    for (const [label, template] of [
      ['unused parameter (lint)', 'param unused string\n'],
      [
        'wrong property casing (type)',
        "resource s 'Microsoft.Search/searchServices@2025-05-01' = {\n  name: 'x'\n  location: 'westeurope'\n  sku: { name: 'basic' }\n  properties: { hostingMode: 'default' }\n}\n",
      ],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'ehub-bicep-'));
      try {
        copyFileSync(join(bicepDir, 'bicepconfig.json'), join(dir, 'bicepconfig.json'));
        writeFileSync(join(dir, 'main.bicep'), template);
        const result = spawnSync(
          process.execPath,
          [
            join(repo, 'infrastructure', 'scripts', 'validate-bicep.mjs'),
            '--require-bicep',
            '--dir',
            dir,
          ],
          { encoding: 'utf8' },
        );
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toMatch(/Warning|Error/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 300_000);
});

/** The `{ name: 'X', ... }` entries of a `var <name> = [...]` or `concat(..., [...])` block. */
function settingBlock(variable: string): string {
  const start = main.indexOf(`var ${variable} = `);
  expect(start, `var ${variable} in main.bicep`).toBeGreaterThan(-1);
  const end = main.indexOf('\n]', start);
  const end2 = main.indexOf('\n])', start);
  return main.slice(start, end2 > -1 && end2 <= end ? end2 : end);
}

function settingNames(variable: string): string[] {
  return [...settingBlock(variable).matchAll(/\{ name: '([A-Z][A-Z0-9_]*)'/g)].map(
    (match) => match[1] ?? '',
  );
}

/** Settings whose value in the given blocks is a string literal, tested as written. */
function literalValues(variables: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    variables.flatMap((variable) =>
      [
        ...settingBlock(variable).matchAll(/\{ name: '([A-Z][A-Z0-9_]*)', value: '([^']*)' \}/g),
      ].map((match) => [match[1] ?? '', match[2] ?? '']),
    ),
  );
}

/**
 * Representative values for every setting the template defines, in the form Azure will supply
 * them. A new setting in main.bicep needs a value here, so this test keeps up with the template.
 */
const SAMPLE_VALUES: Record<string, string> = {
  NODE_ENV: 'production',
  AZURE_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  AZURE_CLIENT_ID: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  MOODLE_BASE_URL: 'https://ehub.pilot.invalid',
  MOODLE_TOKEN: 'moodle-token-from-key-vault-0123456789',
  APPLICATIONINSIGHTS_CONNECTION_STRING:
    'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=https://southafricanorth-1.in.applicationinsights.azure.com/',
  AZURE_SEARCH_ENDPOINT: 'https://srch-ehub-test-abc123.search.windows.net',
  AZURE_SEARCH_VECTOR_DIMENSIONS: '1536',
  AZURE_SEARCH_SEMANTIC_ENABLED: 'true',
  RETRIEVAL_SEMANTIC_RANKING: 'true',
  AZURE_OPENAI_ENDPOINT: 'https://pilot-openai.openai.azure.com',
  AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embedding',
  AZURE_OPENAI_EMBEDDING_DIMENSIONS: '1536',
  SYNC_COURSE_IDS: '12,15',
  SYNC_ALL_COURSES: 'false',
  SYNC_STATE_DIR: '/mnt/state/sync',
  IDENTITY_STATE_DIR: '/mnt/state/identity',
  ADMIN_STATE_DIR: '/mnt/state/admin',
  EMBEDDING_CACHE_DIR: '/mnt/state/embedding-cache',
  IDENTITY_EMAIL_MATCHING: 'true',
  AZURE_LOG_LEVEL: 'error',
  PORT: '3000',
  API_HOST: '0.0.0.0',
  ENTRA_API_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
  ENTRA_ALLOWED_CLIENT_APP_IDS:
    '33333333-4444-4555-8666-777777777777,44444444-5555-4666-8777-888888888888',
  ADMIN_UI_ENABLED: 'true',
  ADMIN_SPA_CLIENT_ID: '44444444-5555-4666-8777-888888888888',
  ADMIN_PUBLIC_ORIGIN:
    'https://ca-ehub-test-api.blue-sea-1234.southafricanorth.azurecontainerapps.io',
  TEAMS_BOT_PORT: '3978',
  TEAMS_BOT_CLIENT_ID: '33333333-4444-4555-8666-777777777777',
  TEAMS_BOT_CLIENT_SECRET: 'bot-client-secret-from-key-vault-0123',
  TEAMS_BOT_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  TEAMS_SSO_CONNECTION_NAME: 'ehub-sso',
  TEAMS_API_BASE_URL:
    'https://ca-ehub-test-api.blue-sea-1234.southafricanorth.azurecontainerapps.io',
  TEAMS_ALLOWED_LINK_HOSTS: 'ehub.pilot.invalid',
};

function serviceEnv(
  names: readonly string[],
  literals: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    // A literal in the template is what Azure will set; samples stand in for expressions.
    const value = literals[name] ?? SAMPLE_VALUES[name];
    expect(value, `SAMPLE_VALUES needs a value for ${name}`).toBeDefined();
    env[name] = value ?? '';
  }
  return env;
}

function problems(feature: ConfigFeature, env: Record<string, string>): string[] {
  const result = CONFIG_FEATURES[feature].safeParse(cleanEnvironment(env));
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const core = settingNames('coreSettings');
const coreSecrets = settingNames('coreSecrets');
const services = {
  api: {
    names: [...core, ...settingNames('apiSettings'), ...coreSecrets],
    literals: literalValues(['coreSettings', 'apiSettings']),
    // `serve`: answers (search, embeddings, chat), sign-in, Moodle authorisation, the admin page
    // and the in-process sync jobs it can run.
    features: [
      'runtime',
      'moodle',
      'azureSearch',
      'azureOpenAI',
      'retrieval',
      'embeddings',
      'chat',
      'apiServer',
      'entraAuth',
      'authorization',
      'admin',
      'sync',
      'extraction',
      'chunking',
      'observability',
    ] as ConfigFeature[],
  },
  jobs: {
    names: [...core, ...settingNames('jobSettings'), ...coreSecrets],
    literals: literalValues(['coreSettings', 'jobSettings']),
    features: [
      'runtime',
      'moodle',
      'azureSearch',
      'azureOpenAI',
      'embeddings',
      'extraction',
      'chunking',
      'sync',
      'authorization',
      'observability',
    ] as ConfigFeature[],
  },
  bot: {
    names: [...settingNames('botSettings'), ...settingNames('botSecrets')],
    literals: literalValues(['botSettings']),
    features: ['runtime', 'teams', 'observability'] as ConfigFeature[],
  },
};

describe('settings from main.bicep', () => {
  it('reads literal values from each service’s own settings, not only the names', () => {
    for (const service of Object.values(services)) {
      expect(service.literals['NODE_ENV']).toBe('production');
    }
    expect(services.api.literals['API_HOST']).toBe('0.0.0.0');
    expect(services.jobs.literals['SYNC_STATE_DIR']).toBe('/mnt/state/sync');
  });

  it('finds each service’s settings in the template', () => {
    expect(core).toContain('MOODLE_BASE_URL');
    expect(coreSecrets).toEqual(['MOODLE_TOKEN', 'APPLICATIONINSIGHTS_CONNECTION_STRING']);
    expect(services.api.names).toContain('ENTRA_API_CLIENT_ID');
    expect(services.bot.names).toContain('TEAMS_BOT_CLIENT_SECRET');
  });

  for (const [service, { names, literals, features }] of Object.entries(services)) {
    it(`gives the ${service} a valid production configuration`, () => {
      const env = serviceEnv(names, literals);
      expect(env['NODE_ENV']).toBe('production');
      for (const feature of features) {
        expect(problems(feature, env), `${service}: ${feature}`).toEqual([]);
      }
      // The all-variables schema requires Moodle, Search and OpenAI settings, which the bot
      // deliberately does not have; its features above cover it.
      if (service !== 'bot') {
        expect(
          applicationConfigSchema.safeParse(cleanEnvironment(env)).success,
          `${service}: every variable`,
        ).toBe(true);
      }
    });
  }

  it('does not give secrets as plain settings', () => {
    const plain = [
      ...core,
      ...settingNames('apiSettings'),
      ...settingNames('jobSettings'),
      ...settingNames('botSettings'),
    ];
    for (const secret of [
      'MOODLE_TOKEN',
      'TEAMS_BOT_CLIENT_SECRET',
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
      'AZURE_SEARCH_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AZURE_CLIENT_SECRET',
    ]) {
      expect(plain).not.toContain(secret);
    }
  });

  it('never enables development identities in Azure', () => {
    const all = Object.values(services).flatMap((service) => service.names);
    expect(all.filter((name) => name.includes('DEV_'))).toEqual([]);
  });

  it('gives the bot no Moodle, search or model access', () => {
    expect(
      services.bot.names.filter((name) => /^(MOODLE|AZURE_SEARCH|AZURE_OPENAI)/.test(name)),
    ).toEqual([]);
  });
});

describe('committed infrastructure files', () => {
  const infrastructure = join(repo, 'infrastructure');
  const committed = files(infrastructure, /\.(bicep|bicepparam|json|sh|ps1|mjs|example)$/);

  // Azure built-in role definition IDs (public, the same in every tenant), checked against
  // https://learn.microsoft.com/azure/role-based-access-control/built-in-roles.
  const BUILT_IN_ROLES = new Set([
    'acdd72a7-3385-48ef-bd42-f606fba81ae7', // Reader
    '7ca78c08-252a-4471-8644-bb5ff32d4ba0', // Search Service Contributor
    '8ebe5a00-799e-43f5-93ac-243d3dce84a7', // Search Index Data Contributor
    '1407120a-92aa-4202-b7e9-c0e197c71c8f', // Search Index Data Reader
    '7f951dda-4ed3-4680-a7ca-43fe172d538d', // AcrPull
    '4633458b-17de-408a-b874-0445c86b69e6', // Key Vault Secrets User
    'b86a8fe4-44ce-4948-aee5-eccb2c155cd7', // Key Vault Secrets Officer
    '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd', // Cognitive Services OpenAI User
    'ba92f5b4-2d11-453d-a403-e96b0029c9fe', // Storage Blob Data Contributor
  ]);
  const PLACEHOLDER = /^0{8}-0{4}-[0-4]0{3}-[08]0{3}-0{11}[0-9]$/;

  it('contain no tenant, subscription or client IDs', () => {
    for (const file of committed) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      )) {
        const id = match[0].toLowerCase();
        expect(
          BUILT_IN_ROLES.has(id) || PLACEHOLDER.test(id),
          `${relative(repo, file)}: ${id}`,
        ).toBe(true);
      }
    }
  });

  it('use only built-in role IDs that are spelled correctly', () => {
    const used = new Set<string>();
    for (const file of files(bicepDir, /\.bicep$/)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'([0-9a-f-]{36})'/g))
        used.add(match[1] ?? '');
    }
    expect([...used].filter((id) => !BUILT_IN_ROLES.has(id))).toEqual([]);
  });

  it('contain no secrets or keys', () => {
    for (const file of committed) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(repo, file)).not.toMatch(
        /AccountKey=|InstrumentationKey=[0-9a-f]{8}-(?!0000)/,
      );
      expect(text, relative(repo, file)).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });

  it('never output a key, secret or connection string', () => {
    for (const file of files(bicepDir, /\.bicep$/)) {
      for (const line of readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('output '))) {
        expect(line, relative(repo, file)).not.toMatch(
          /listKeys|secret|ConnectionString|sharedKey|accountKey|password/i,
        );
      }
    }
  });

  it('read tenant-specific parameters from the environment, not the files', () => {
    for (const file of files(join(bicepDir, 'parameters'), /\.bicepparam$/)) {
      const text = readFileSync(file, 'utf8');
      for (const name of [
        'openAiAccountName',
        'openAiEndpoint',
        'moodleBaseUrl',
        'entraApiClientId',
        'botClientId',
        'adminSpaClientId',
        'deployerPrincipalId',
      ]) {
        expect(text, `${relative(repo, file)}: ${name}`).toMatch(
          new RegExp(`param ${name} = readEnvironmentVariable\\(`),
        );
      }
    }
  });

  it('keep the validation placeholders obviously fake', () => {
    for (const value of Object.values(PLACEHOLDER_ENV)) {
      expect(value).toMatch(/placeholder|example\.com|^0{8}-|^(ehub|chat|embedding|1536|12)$/);
    }
  });

  it('protect production data from deletion and accidental purge', () => {
    const prod = readFileSync(join(bicepDir, 'parameters', 'prod.bicepparam'), 'utf8');
    expect(prod).toMatch(/param protectData = true/);
    expect(prod).toMatch(/param keyVaultPurgeProtection = true/);
    expect(prod).toMatch(/param searchReplicaCount = 2/);
  });

  it('never let Bicep create or delete the search index', () => {
    for (const file of files(bicepDir, /\.bicep$/)) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      expect(code, relative(repo, file)).not.toMatch(
        /deploymentScripts|\/indexes|search:create-index/,
      );
    }
  });

  it('keep API keys disabled on Azure AI Search', () => {
    expect(readFileSync(join(bicepDir, 'modules', 'search.bicep'), 'utf8')).toMatch(
      /disableLocalAuth: true/,
    );
  });

  it('serve HTTPS only', () => {
    expect(readFileSync(join(bicepDir, 'modules', 'containerApp.bicep'), 'utf8')).toMatch(
      /allowInsecure: false/,
    );
    expect(readFileSync(join(bicepDir, 'modules', 'storage.bicep'), 'utf8')).toMatch(
      /supportsHttpsTrafficOnly: true/,
    );
  });
});
