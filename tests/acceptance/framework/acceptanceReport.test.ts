import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateSuites,
  type AcceptanceSuite,
  type VitestFileResult,
} from '../../../scripts/acceptance-report.mjs';
import { ATTACK_KINDS } from './datasets.js';

/*
 * The report decides whether an acceptance suite "passes", so its logic is tested on its own: a
 * bug here could otherwise turn a failing, skipped or missing suite into a pass, which is worse
 * than having no report at all.
 */

const root = '/repo';

function file(name: string, statuses: string[]): VitestFileResult {
  return {
    name: `${root}/${name}`,
    assertionResults: statuses.map((status) => ({ ancestorTitles: [], status })),
  };
}

function suite(files: string[], requires: AcceptanceSuite['requires'] = 'none'): AcceptanceSuite {
  return { id: 'X', name: 'A suite', requires, proves: 'Something.', files };
}

describe('acceptance report: evaluateSuites', () => {
  it('passes a suite when every listed file ran and passed', () => {
    const [result] = evaluateSuites(
      [suite(['a.test.ts', 'b.test.ts'])],
      [file('a.test.ts', ['passed', 'passed']), file('b.test.ts', ['passed'])],
      root,
    );
    expect(result).toMatchObject({ result: 'pass', passed: 3, failed: 0, skipped: 0, missing: [] });
  });

  it('fails a suite when any test failed', () => {
    const [result] = evaluateSuites(
      [suite(['a.test.ts'])],
      [file('a.test.ts', ['passed', 'failed'])],
      root,
    );
    expect(result).toMatchObject({ result: 'fail', passed: 1, failed: 1 });
  });

  it('fails a suite whose file produced no results (missing, or failed to load)', () => {
    const [result] = evaluateSuites(
      [suite(['a.test.ts', 'gone.test.ts'])],
      [file('a.test.ts', ['passed'])],
      root,
    );
    expect(result).toMatchObject({ result: 'fail', missing: ['gone.test.ts'] });
  });

  it('marks a suite incomplete, not passed, when any test was skipped', () => {
    const [result] = evaluateSuites(
      [suite(['a.test.ts'])],
      [file('a.test.ts', ['passed', 'skipped'])],
      root,
    );
    expect(result).toMatchObject({ result: 'incomplete', passed: 1, skipped: 1 });
  });

  it('never passes a suite with no tests at all', () => {
    expect(evaluateSuites([suite([])], [], root)[0]?.result).toBe('fail');
  });

  it('reports a suite that needs a live service as not-run, whatever the results say', () => {
    const [result] = evaluateSuites(
      [suite(['a.test.ts'], 'azure')],
      [file('a.test.ts', ['failed'])],
      root,
    );
    expect(result).toMatchObject({ result: 'not-run', passed: 0, failed: 0 });
  });
});

describe('acceptance report: catalogue', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const catalogue = JSON.parse(
    readFileSync(join(repo, 'tests', 'acceptance', 'suites.json'), 'utf8'),
  ) as { suites: AcceptanceSuite[] };

  it('references only test files that exist', () => {
    for (const entry of catalogue.suites) {
      for (const path of entry.files) {
        expect(existsSync(join(repo, path)), `${entry.id}: ${path}`).toBe(true);
      }
    }
  });

  it('lists every numbered acceptance suite file, so a new suite cannot go unreported', () => {
    const listed = new Set(catalogue.suites.flatMap((entry) => entry.files));
    const onDisk = readdirSync(join(repo, 'tests', 'acceptance'))
      .filter((name) => /^\d+-.*\.test\.ts$/.test(name))
      .map((name) => `tests/acceptance/${name}`);
    expect(onDisk.length).toBeGreaterThan(0);
    for (const path of onDisk) {
      expect(listed.has(path), path).toBe(true);
    }
  });

  it('has unique IDs, a stated requirement and a stated claim per suite', () => {
    const ids = catalogue.suites.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of catalogue.suites) {
      expect(['none', 'moodle', 'azure', 'teams'], entry.id).toContain(entry.requires);
      expect(entry.proves.length, entry.id).toBeGreaterThan(20);
      // A check nobody can run is not a check: an environment suite must say how.
      if (entry.requires !== 'none') {
        expect(entry.command, entry.id).toBeTruthy();
      }
    }
  });

  it('covers the eighteen suites Prompt 18 requires', () => {
    const numbered = catalogue.suites.filter((entry) => /^\d+$/.test(entry.id));
    expect(numbered.map((entry) => entry.id)).toEqual(
      Array.from({ length: 19 }, (_, index) => String(index + 1).padStart(2, '0')),
    );
  });

  it('keeps the attack list the security report uses in one place', () => {
    expect(new Set(ATTACK_KINDS).size).toBe(ATTACK_KINDS.length);
    expect(ATTACK_KINDS).toHaveLength(12);
  });
});
