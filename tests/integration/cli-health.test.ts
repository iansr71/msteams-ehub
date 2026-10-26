import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
// Run outside the workspace so a developer's local .env cannot influence the result.
const isolatedCwd = mkdtempSync(join(tmpdir(), 'ehub-cli-'));

afterAll(() => {
  rmSync(isolatedCwd, { recursive: true, force: true });
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(app: 'api' | 'indexer', args: string[], env: Record<string, string>): CliResult {
  const result = spawnSync(
    tsxBin,
    ['--conditions=@ehub/source', join(repoRoot, 'apps', app, 'src', 'cli.ts'), ...args],
    {
      cwd: isolatedCwd,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', ...env },
      timeout: 25_000,
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.each(['api', 'indexer'] as const)('%s CLI', (app) => {
  it('health exits 0 and writes only a JSON report to stdout', () => {
    const result = runCli(app, ['health'], {});
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report['service']).toBe(`ehub-${app}`);
    expect(['pass', 'warn']).toContain(report['status']);
    expect(typeof report['correlationId']).toBe('string');
  });

  it('health exits 1 when runtime configuration is invalid', () => {
    const result = runCli(app, ['health'], { PORT: 'invalid' });
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout) as Record<string, unknown>)['status']).toBe('fail');
  });

  it('health never prints secrets to stdout or stderr, even at trace level', () => {
    const token = 'fake-moodle-token-integration-0123456789';
    const clientSecret = 'fake-client-secret-integration';
    const result = runCli(app, ['health'], {
      LOG_LEVEL: 'trace',
      MOODLE_BASE_URL: 'https://ehub.example.test',
      MOODLE_TOKEN: token,
      AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000001',
      AZURE_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
      AZURE_CLIENT_SECRET: clientSecret,
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.stderr).toContain('Health check completed.');
    expect(combined).not.toContain(token);
    expect(combined).not.toContain(clientSecret);
  });

  it('rejects an unknown command with exit code 2', () => {
    const result = runCli(app, ['does-not-exist'], {});
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Unknown command');
  });
});
