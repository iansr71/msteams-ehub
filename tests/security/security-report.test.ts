import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateControls,
  type SecurityControl,
  type VitestFileResult,
} from '../../scripts/security-report.mjs';

/*
 * The report decides whether a security control "passes", so its logic is tested on its own:
 * a bug here could otherwise turn a failing, skipped or missing test into a pass.
 */

const root = '/repo';

function file(name: string, assertions: { suite?: string; status: string }[]): VitestFileResult {
  return {
    name: `${root}/${name}`,
    assertionResults: assertions.map((assertion) => ({
      ancestorTitles: assertion.suite === undefined ? [] : [assertion.suite],
      status: assertion.status,
    })),
  };
}

function control(tests: SecurityControl['tests']): SecurityControl {
  return { id: 'X-1', area: 'Test', control: 'A control', tests };
}

describe('security report: evaluateControls', () => {
  it('passes a control when every referenced test ran and passed', () => {
    const [result] = evaluateControls(
      [control([{ file: 'a.test.ts' }, { file: 'b.test.ts', suite: 'attack' }])],
      [
        file('a.test.ts', [{ status: 'passed' }, { status: 'passed' }]),
        file('b.test.ts', [{ suite: 'attack', status: 'passed' }]),
      ],
      root,
    );
    expect(result).toMatchObject({ result: 'pass', passed: 3, failed: 0, skipped: 0, missing: [] });
  });

  it('fails a control when any referenced test failed', () => {
    const [result] = evaluateControls(
      [control([{ file: 'a.test.ts' }])],
      [file('a.test.ts', [{ status: 'passed' }, { status: 'failed' }])],
      root,
    );
    expect(result).toMatchObject({ result: 'fail', passed: 1, failed: 1 });
  });

  it('fails a control whose test file produced no results (missing, or failed to load)', () => {
    const [result] = evaluateControls(
      [control([{ file: 'a.test.ts' }, { file: 'gone.test.ts' }])],
      [file('a.test.ts', [{ status: 'passed' }])],
      root,
    );
    expect(result).toMatchObject({ result: 'fail', missing: ['gone.test.ts'] });
  });

  it('fails a control whose suite name matches no test (a renamed describe block)', () => {
    const [result] = evaluateControls(
      [control([{ file: 'a.test.ts', suite: 'attack: renamed' }])],
      [file('a.test.ts', [{ suite: 'attack: original', status: 'passed' }])],
      root,
    );
    expect(result).toMatchObject({ result: 'fail', missing: ['a.test.ts › attack: renamed'] });
  });

  it('counts only tests in the named suite', () => {
    const [result] = evaluateControls(
      [control([{ file: 'a.test.ts', suite: 'attack' }])],
      [
        file('a.test.ts', [
          { suite: 'attack', status: 'passed' },
          { suite: 'other', status: 'failed' },
        ]),
      ],
      root,
    );
    expect(result).toMatchObject({ result: 'pass', passed: 1, failed: 0 });
  });

  it('marks a control incomplete, not passed, when any of its tests was skipped', () => {
    const [result] = evaluateControls(
      [control([{ file: 'a.test.ts' }])],
      [file('a.test.ts', [{ status: 'passed' }, { status: 'skipped' }])],
      root,
    );
    expect(result).toMatchObject({ result: 'incomplete', passed: 1, skipped: 1 });
  });

  it('never passes a control with no tests at all', () => {
    const [result] = evaluateControls([control([])], [], root);
    expect(result?.result).toBe('fail');
  });
});

describe('security report: catalogue', () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const catalogue = JSON.parse(
    readFileSync(join(repo, 'tests', 'security', 'controls.json'), 'utf8'),
  ) as { controls: SecurityControl[] };

  it('references only test files that exist', () => {
    for (const entry of catalogue.controls) {
      for (const test of entry.tests) {
        expect(existsSync(join(repo, test.file)), `${entry.id}: ${test.file}`).toBe(true);
      }
    }
  });

  it('has unique IDs and covers every attack Prompt 17 requires', () => {
    const ids = catalogue.controls.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const attacks = catalogue.controls.flatMap((entry) =>
      entry.attack === undefined ? [] : [entry.attack],
    );
    expect(attacks.sort()).toEqual(
      [
        'admin-role bypass',
        'forged course ID',
        'forged identity fields',
        'hidden HTML instructions',
        'malicious citation',
        'oversized question',
        'PDF prompt injection',
        'script output',
        'SSRF URL',
        'token leakage through exceptions',
        'unauthorized resource URL',
        'user prompt injection',
      ].sort(),
    );
  });
});
