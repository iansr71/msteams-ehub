#!/usr/bin/env tsx
/*
 * Generates the variable tables in docs/configuration-reference.md from the Zod schemas, so the
 * reference cannot drift from what the code actually accepts. Run with:
 *
 *   pnpm config:reference            # writes docs/configuration-reference.md
 *   pnpm config:reference --check    # exits 1 if the committed file is out of date
 *
 * Only the generated block is replaced; the prose around it is written by hand.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FEATURES,
  CONFIG_FEATURE_VARIABLES,
  PRODUCTION_SECRET_VARIABLES,
  applicationConfigSchema,
  type ConfigFeature,
} from '@ehub/shared';
import type { z } from 'zod';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(root, 'docs', 'configuration-reference.md');
const START = '<!-- generated: variables (pnpm config:reference) -->';
const END = '<!-- /generated -->';

/** Feature order and the heading each gets. */
const SECTIONS: readonly { readonly feature: ConfigFeature; readonly title: string }[] = [
  { feature: 'runtime', title: 'Runtime' },
  { feature: 'moodle', title: 'Moodle' },
  { feature: 'extraction', title: 'Extraction limits' },
  { feature: 'chunking', title: 'Chunking' },
  { feature: 'azureSearch', title: 'Azure AI Search' },
  { feature: 'azureOpenAI', title: 'Azure OpenAI' },
  { feature: 'embeddings', title: 'Embeddings' },
  { feature: 'retrieval', title: 'Retrieval' },
  { feature: 'chat', title: 'Answer generation' },
  { feature: 'sync', title: 'Synchronisation' },
  { feature: 'apiServer', title: 'Answer API' },
  { feature: 'authorization', title: 'Identity and course authorisation' },
  { feature: 'entraAuth', title: 'Microsoft Entra ID' },
  { feature: 'teams', title: 'Teams bot' },
  { feature: 'teamsManifest', title: 'Teams manifest (build-time)' },
  { feature: 'admin', title: 'Administration area' },
  { feature: 'azureIdentity', title: 'Azure identity' },
  { feature: 'observability', title: 'Observability' },
];

type Unknown = z.ZodType;

/** The default a schema applies when the variable is absent, as text. */
function defaultOf(schema: Unknown): string {
  const parsed = schema.safeParse(undefined);
  if (!parsed.success || parsed.data === undefined) {
    return '';
  }
  const value: unknown = parsed.data;
  if (Array.isArray(value)) {
    return value.length === 0 ? '(empty)' : `\`${value.map((entry) => String(entry)).join(',')}\``;
  }
  // Defaults are strings, numbers, booleans or arrays of those; anything else is a schema
  // change that should be made visible rather than stringified into "[object Object]".
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `\`${String(value)}\``;
  }
  return '(see the schema)';
}

function isRequired(schema: Unknown): boolean {
  return !schema.safeParse(undefined).success;
}

/** One-line note for the variables that need one; everything else is named by the doc's prose. */
const NOTES: Readonly<Record<string, string>> = {
  MOODLE_TOKEN: 'Key Vault secret `moodle-token`.',
  MOODLE_TOKEN_EXPIRES_ON: 'Recorded expiry (YYYY-MM-DD); `pnpm preflight` warns 30 days ahead.',
  AZURE_SEARCH_API_KEY:
    'Not used in production: the deployed service has key authentication disabled.',
  AZURE_OPENAI_API_KEY: 'Not used in production: managed identity instead.',
  TEAMS_BOT_CLIENT_SECRET: 'Key Vault secret `teams-bot-client-secret`.',
  APPLICATIONINSIGHTS_CONNECTION_STRING: 'Key Vault secret `appinsights-connection-string`.',
  SYNC_ALL_COURSES: 'Must stay off in the pilot; the preflight fails if it is on.',
  SYNC_COURSE_IDS: 'The approved pilot courses.',
  API_DEV_MOCK_IDENTITY: 'Development only; the API refuses to start with it on in production.',
  TEAMS_DEV_MOCK_IDENTITY: 'Development only; refused in production.',
  TEAMS_DEV_ALLOW_UNAUTHENTICATED: 'Development only; refused in production.',
  TEAMS_SSO_RESOURCE: 'Must match `ENTRA_API_APP_ID_URI` (optionally with the scope appended).',
  ENTRA_ALLOWED_CLIENT_APP_IDS: 'Must include `TEAMS_BOT_CLIENT_ID`.',
  TEAMS_ALLOWED_LINK_HOSTS: 'Must include the Moodle host, or citation links are not rendered.',
  ADMIN_UI_ENABLED: 'Off by default; needs `ADMIN_SPA_CLIENT_ID` when on.',
};

/**
 * Variables whose value is a credential. Named explicitly rather than matched by pattern: a
 * pattern on TOKEN or KEY also catches CHUNK_MAX_TOKENS and TOP_K, and a reference that calls
 * ordinary settings secret teaches people to ignore the label.
 */
const SECRET_VARIABLES = new Set<string>([
  ...PRODUCTION_SECRET_VARIABLES,
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  'AZURE_SEARCH_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_CLIENT_SECRET',
  'LOCAL_POSTGRES_PASSWORD',
]);

function table(feature: ConfigFeature): string[] {
  const schema = CONFIG_FEATURES[feature];
  const shape = (schema as unknown as { shape?: Record<string, Unknown> }).shape;
  const own = CONFIG_FEATURE_VARIABLES[feature];
  const names = [...own].sort();
  const rows = names.flatMap((name) => {
    const all: Record<string, Unknown> = applicationConfigSchema.shape;
    const field = shape?.[name] ?? all[name];
    if (field === undefined) {
      return [];
    }
    const secret = SECRET_VARIABLES.has(name);
    const required = isRequired(field);
    return [
      `| \`${name}\` | ${required ? 'required' : 'optional'} | ${defaultOf(field) || '—'} | ${[secret ? '**secret**' : '', NOTES[name] ?? ''].filter((part) => part !== '').join(' ')} |`,
    ];
  });
  return rows;
}

function generate(): string {
  const lines = [START, ''];
  for (const section of SECTIONS) {
    const rows = table(section.feature);
    if (rows.length === 0) {
      continue;
    }
    lines.push(
      `### ${section.title}`,
      '',
      '| Variable | Required | Default | Notes |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    );
  }
  lines.push(END);
  return lines.join('\n');
}

/**
 * Formats Markdown the way `pnpm format:check` expects (aligned tables), so a regenerated
 * reference does not fail the next gate run. Done on a copy, because `--check` must not write.
 */
function formatMarkdown(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'ehub-config-ref-'));
  const file = join(directory, 'configuration-reference.md');
  try {
    writeFileSync(file, text);
    const run = spawnSync(
      process.execPath,
      [join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'), '--write', file],
      { cwd: root, encoding: 'utf8', stdio: 'ignore' },
    );
    return run.status === 0 ? readFileSync(file, 'utf8') : text;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main(): number {
  const check = process.argv.includes('--check');
  const current = readFileSync(DOC, 'utf8');
  const startAt = current.indexOf(START);
  const endAt = current.indexOf(END);
  if (startAt === -1 || endAt === -1) {
    process.stderr.write(`${DOC} has no generated block (${START}).\n`);
    return 2;
  }
  const updated = formatMarkdown(
    `${current.slice(0, startAt)}${generate()}${current.slice(endAt + END.length)}`,
  );
  if (updated === current) {
    process.stdout.write('docs/configuration-reference.md is up to date.\n');
    return 0;
  }
  if (check) {
    process.stderr.write(
      'docs/configuration-reference.md is out of date. Run `pnpm config:reference`.\n',
    );
    return 1;
  }
  writeFileSync(DOC, updated);
  process.stdout.write('docs/configuration-reference.md updated.\n');
  return 0;
}

process.exitCode = main();
