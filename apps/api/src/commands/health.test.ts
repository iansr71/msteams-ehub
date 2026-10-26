import { describe, expect, it } from 'vitest';

import { buildApiHealthReport, createHealthCommand, SERVICE_NAME } from './health.js';

const clock = (): Date => new Date('2026-01-01T00:00:00.000Z');

async function runHealth(env: Record<string, string>) {
  const output: string[] = [];
  const exitCode = await createHealthCommand(env).run({
    args: [],
    logger: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
      isLevelEnabled: () => false,
      child() {
        return this;
      },
    },
    stdout: (text) => output.push(text),
  });
  return { exitCode, report: JSON.parse(output.join('')) as Record<string, unknown> };
}

describe('api health', () => {
  it('passes with defaults and only warns about features not needed yet', () => {
    const report = buildApiHealthReport({}, clock);
    expect(report.service).toBe(SERVICE_NAME);
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(report.status).toBe('warn');
    expect(report.checks.find((check) => check.name === 'configuration.runtime')?.status).toBe(
      'pass',
    );
    expect(report.checks.find((check) => check.name === 'configuration.azureSearch')?.status).toBe(
      'warn',
    );
  });

  it('exits 0 and prints JSON when healthy', async () => {
    const { exitCode, report } = await runHealth({});
    expect(exitCode).toBe(0);
    expect(report['service']).toBe(SERVICE_NAME);
  });

  it('exits 1 when runtime configuration is invalid', async () => {
    const { exitCode, report } = await runHealth({ PORT: 'not-a-port' });
    expect(exitCode).toBe(1);
    expect(report['status']).toBe('fail');
  });

  it('never prints configured secret values', async () => {
    const secret = 'fake-moodle-token-0123456789abcdef';
    const { report } = await runHealth({
      MOODLE_BASE_URL: 'https://ehub.example.test',
      MOODLE_TOKEN: secret,
      AZURE_CLIENT_SECRET: 'fake-client-secret-value',
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('fake-client-secret-value');
  });
});
