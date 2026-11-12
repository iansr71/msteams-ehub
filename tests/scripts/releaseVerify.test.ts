import { describe, expect, it } from 'vitest';

import {
  redactOutput,
  summarizeSteps,
  renderMarkdown,
  type ReleaseStep,
} from '../../scripts/release-verify.mjs';

/*
 * The release verdict decides whether anyone is told a build is ready, so the rule that matters
 * most is tested first: a gate nobody could run must hold the release exactly as a failing gate
 * does. Prompt 20 is explicit that production readiness is not claimed when a required gate has
 * failed, and "we could not run it" is not a pass.
 */

function step(id: string, result: ReleaseStep['result'], reason?: string): ReleaseStep {
  return {
    id,
    name: id,
    result,
    ...(reason === undefined ? {} : { reason }),
    durationMs: 1,
    output: '',
  };
}

describe('release verdict', () => {
  it('is ready only when every step passed', () => {
    const summary = summarizeSteps([step('lint', 'pass'), step('build', 'pass')]);
    expect(summary).toMatchObject({ ready: true, verdict: 'ready', failed: [], blocked: [] });
  });

  it('is not ready when a step failed', () => {
    const summary = summarizeSteps([step('lint', 'pass'), step('unit', 'fail')]);
    expect(summary).toMatchObject({ ready: false, verdict: 'not-ready-failed', failed: ['unit'] });
  });

  it('is not ready when a step could not be run at all', () => {
    const summary = summarizeSteps([
      step('lint', 'pass'),
      step('production-config', 'blocked', 'no production configuration here'),
    ]);
    expect(summary).toMatchObject({
      ready: false,
      verdict: 'not-ready-incomplete',
      blocked: ['production-config'],
    });
  });

  it('tolerates a skipped optional step, and still names it', () => {
    const summary = summarizeSteps([step('lint', 'pass'), step('bicep', 'skipped', 'no CLI')]);
    expect(summary).toMatchObject({
      ready: true,
      verdict: 'ready-with-skipped-steps',
      skipped: ['bicep'],
    });
  });

  it('reports every failure, not just the first', () => {
    const summary = summarizeSteps([
      step('lint', 'fail'),
      step('unit', 'fail'),
      step('bicep', 'blocked', 'x'),
    ]);
    expect(summary.failed).toEqual(['lint', 'unit']);
    expect(summary.blocked).toEqual(['bicep']);
  });
});

describe('release report output', () => {
  const report = {
    generatedAt: '2026-11-12T10:00:00.000Z',
    node: 'v22.0.0',
    version: '0.1.0',
    commit: 'abcdef123456',
    branch: 'phase/20-production',
    dirty: false,
    rollbackCommit: '123456abcdef',
    rollbackTag: undefined,
    ready: false,
    verdict: 'not-ready-incomplete',
    results: {
      build: 'pass',
      unit: 'pass',
      integration: 'pass',
      acceptance: 'pass',
      security: 'pass',
    },
    steps: [step('production-config', 'blocked', 'no production configuration here')],
    knownLimitations: ['Grounding is mechanical.'],
    manualChecks: ['Run `pnpm preflight` in the deployed environment.'],
    teamsPackages: [],
    artifacts: [{ path: 'pnpm-lock.yaml', bytes: 10, sha256: 'a'.repeat(64) }],
  };

  it('says plainly that the release is not ready, and why', () => {
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('NOT-READY-INCOMPLETE');
    expect(markdown).toContain('not ready');
    expect(markdown).toContain('no production configuration here');
  });

  it('carries the version, commit, rollback commit and artifact checksums', () => {
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('0.1.0');
    expect(markdown).toContain('abcdef123456');
    expect(markdown).toContain('123456abcdef');
    expect(markdown).toContain('a'.repeat(64));
  });

  it('points at the command that builds the Teams package when there is none', () => {
    expect(renderMarkdown(report)).toContain('pnpm teams:package');
  });

  it('does not claim the deployment works when every gate passed', () => {
    const markdown = renderMarkdown({ ...report, ready: true, verdict: 'ready', steps: [] });
    expect(markdown).toContain('not a statement that the deployment works');
  });
});

describe('output redaction', () => {
  it('removes long credential-shaped values', () => {
    expect(redactOutput('MOODLE_TOKEN="abcdef0123456789abcdef0123456789"')).not.toContain(
      'abcdef0123456789abcdef0123456789',
    );
  });

  it('removes a Moodle token from a URL and an instrumentation key', () => {
    expect(redactOutput('https://e.test/?wstoken=secret-value-here&x=1')).toContain(
      'wstoken=[redacted]',
    );
    expect(redactOutput('InstrumentationKey=abc-123;Ingestion=x')).toContain(
      'InstrumentationKey=[redacted]',
    );
  });

  it('leaves ordinary failure text readable', () => {
    const text = 'FAIL tests/foo.test.ts > does the thing\nexpected 200 to be 401';
    expect(redactOutput(text)).toContain('expected 200 to be 401');
  });
});
