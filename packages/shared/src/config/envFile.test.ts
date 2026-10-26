import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findWorkspaceRoot, loadLocalEnvFile } from './envFile.js';

const TOUCHED = ['EHUB_ENVFILE_TEST_FROM_FILE', 'EHUB_ENVFILE_TEST_PRESET', 'NODE_ENV'] as const;

describe('local .env loading', () => {
  let root: string;
  let nested: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED) {
      saved.set(key, process.env[key]);
    }
    root = mkdtempSync(join(tmpdir(), 'ehub-env-'));
    nested = join(root, 'apps', 'indexer');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages: ['apps/*']\n");
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the workspace root from a nested package directory', () => {
    expect(findWorkspaceRoot(nested)).toBe(root);
  });

  it('returns undefined when there is no workspace root', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'ehub-no-root-'));
    try {
      expect(findWorkspaceRoot(isolated)).toBeUndefined();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('loads .env from the workspace root without overriding existing variables', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['EHUB_ENVFILE_TEST_PRESET'] = 'from-environment';
    writeFileSync(
      join(root, '.env'),
      'EHUB_ENVFILE_TEST_FROM_FILE=from-file\nEHUB_ENVFILE_TEST_PRESET=from-file\n',
    );

    expect(loadLocalEnvFile(nested)).toEqual({ loaded: true, path: join(root, '.env') });
    expect(process.env['EHUB_ENVFILE_TEST_FROM_FILE']).toBe('from-file');
    expect(process.env['EHUB_ENVFILE_TEST_PRESET']).toBe('from-environment');
  });

  it('reports when no .env exists', () => {
    process.env['NODE_ENV'] = 'test';
    expect(loadLocalEnvFile(nested)).toEqual({ loaded: false, reason: 'not-found' });
  });

  it('never loads a .env file in production', () => {
    process.env['NODE_ENV'] = 'production';
    Reflect.deleteProperty(process.env, 'EHUB_ENVFILE_TEST_FROM_FILE');
    writeFileSync(join(root, '.env'), 'EHUB_ENVFILE_TEST_FROM_FILE=from-file\n');

    expect(loadLocalEnvFile(nested)).toEqual({ loaded: false, reason: 'production' });
    expect(process.env['EHUB_ENVFILE_TEST_FROM_FILE']).toBeUndefined();
  });
});
