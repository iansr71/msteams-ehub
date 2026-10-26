import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');

const APPLICATION_VARIABLES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'PORT',
  'MOODLE_BASE_URL',
  'MOODLE_TOKEN',
  'AZURE_SEARCH_ENDPOINT',
  'AZURE_SEARCH_INDEX_NAME',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_CHAT_DEPLOYMENT',
  'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
];

function assignments(): Map<string, string> {
  const lines = readFileSync(resolve(repoRoot, '.env.example'), 'utf8').split(/\r?\n/);
  const result = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    expect(separator, `Malformed line in .env.example: ${trimmed}`).toBeGreaterThan(0);
    result.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return result;
}

describe('.env.example', () => {
  it('declares every application variable', () => {
    const names = [...assignments().keys()];
    for (const variable of APPLICATION_VARIABLES) {
      expect(names).toContain(variable);
    }
  });

  it('contains names only, never example values', () => {
    for (const [name, value] of assignments()) {
      expect(value, `${name} must not have a value in .env.example`).toBe('');
    }
  });
});

describe('.gitignore', () => {
  it('keeps local environment files out of version control', () => {
    const gitignore = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('.env.*');
    expect(gitignore).toContain('!.env.example');
  });
});
