import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * The operational documents are a deliverable: during an incident they are what one
 * administrator has instead of a colleague. These tests check the things that rot silently — a
 * checklist that lost a step, a procedure that was renamed, a cross-reference to a file that no
 * longer exists, a `pnpm` command named in a document but not in package.json.
 *
 * They cannot check that the advice is right. That is what reading it is for.
 */

const repo = fileURLToPath(new URL('../../', import.meta.url));
const docs = join(repo, 'docs');

function read(name: string): string {
  return readFileSync(join(docs, name), 'utf8');
}

/** The documents Prompt 20 requires. */
const REQUIRED_DOCS = [
  'production-deployment.md',
  'teams-deployment.md',
  'moodle-production-setup.md',
  'configuration-reference.md',
  'operations-runbook.md',
  'incident-response.md',
  'backup-and-recovery.md',
  'rollback.md',
  'token-rotation.md',
  'support-troubleshooting.md',
  'acceptance-signoff.md',
  'change-management.md',
];

describe('operational documentation', () => {
  it('has every document the production handover needs', () => {
    for (const name of REQUIRED_DOCS) {
      expect(existsSync(join(docs, name)), name).toBe(true);
    }
  });

  it('keeps all twenty-four deployment checklist steps', () => {
    const text = read('production-deployment.md');
    for (let step = 1; step <= 24; step += 1) {
      expect(text, `checklist step ${String(step)}`).toContain(`${String(step)}. **`);
    }
  });

  it('keeps all sixteen operational procedures', () => {
    const text = read('operations-runbook.md');
    for (let procedure = 1; procedure <= 16; procedure += 1) {
      expect(text, `procedure ${String(procedure)}`).toMatch(
        new RegExp(`^## ${String(procedure)}\\. `, 'm'),
      );
    }
  });

  it('names every pilot control, so none can be dropped quietly', () => {
    const text = read('production-deployment.md');
    for (const control of [
      'SYNC_COURSE_IDS',
      'SYNC_ALL_COURSES',
      'ADMIN_UI_ENABLED',
      'API_DEV_MOCK_IDENTITY',
      'TEAMS_DEV_MOCK_IDENTITY',
      'personal scope',
      'cannot attach files',
    ]) {
      expect(text, control).toContain(control);
    }
  });
});

const PNPM_BUILTINS = new Set([
  'install',
  'add',
  'run',
  'exec',
  'dlx',
  'why',
  'store',
  'audit',
  'dedupe',
  'outdated',
  'list',
  'update',
  'rebuild',
]);

/** Binaries pnpm runs from node_modules/.bin, so `pnpm <binary>` is a real command. */
const LOCAL_BINARIES = new Set(['vitest', 'prettier', 'eslint', 'tsc', 'tsx', 'playwright']);

describe('documentation cross-references', () => {
  const allDocs = readdirSync(docs).filter((name) => name.endsWith('.md'));

  it('points only at documents that exist', () => {
    const missing: string[] = [];
    for (const name of [...allDocs, '../README.md']) {
      const text = readFileSync(join(docs, name), 'utf8');
      for (const match of text.matchAll(/docs\/([A-Za-z0-9._-]+\.md)/g)) {
        const target = match[1];
        if (target !== undefined && !existsSync(join(docs, target))) {
          missing.push(`${name} → docs/${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('names only pnpm commands that exist', () => {
    const scripts = new Set(
      Object.keys(
        (
          JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
            scripts: Record<string, string>;
          }
        ).scripts,
      ),
    );
    // Sub-commands (`pnpm indexer sync:full`) are checked by their first word only: the CLI's own
    // tests cover the rest, and the first word is what has to be a package script.
    const unknown = new Set<string>();
    for (const name of allDocs) {
      for (const match of readFileSync(join(docs, name), 'utf8').matchAll(
        /pnpm ([a-z][a-z0-9:-]*)/g,
      )) {
        // `pnpm evaluation:*` in prose means the family, not a script.
        const command = match[1]?.replace(/:$/, '');
        if (
          command !== undefined &&
          command !== '' &&
          !scripts.has(command) &&
          // pnpm's own commands, and binaries pnpm resolves from node_modules/.bin.
          !PNPM_BUILTINS.has(command) &&
          !LOCAL_BINARIES.has(command)
        ) {
          unknown.add(`${name}: pnpm ${command}`);
        }
      }
    }
    expect([...unknown]).toEqual([]);
  });
});
