import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanRepository, scanText } from '../../scripts/secret-scan.mjs';

/*
 * Secret scanning (`pnpm secrets:scan`). The planted values below are assembled at run time so
 * that this file itself contains nothing the scanner would report.
 */

const j = (...parts: string[]) => parts.join('');
const rules = (path: string, text: string) => scanText(path, text).map((finding) => finding.rule);

describe('secret scan', () => {
  it('finds nothing in the repository', () => {
    const { findings, scanned } = scanRepository(fileURLToPath(new URL('../../', import.meta.url)));
    expect(findings).toEqual([]);
    expect(scanned).toBeGreaterThan(300);
  });

  it.each([
    ['private-key', j('-----BEGIN RSA ', 'PRIVATE KEY-----')],
    ['private-key', j('-----BEGIN ', 'PRIVATE KEY-----')],
    ['github-token', j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')],
    ['aws-access-key', j('AKIA', 'IOSFODNN7EXAMPLE')],
    ['slack-token', j('xoxb-', '123456789012-1234567890123-abcdefghijklmnop')],
    ['google-api-key', j('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')],
    [
      'azure-storage-key',
      j(
        'AccountKey=',
        'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OQ==',
      ),
    ],
    [
      'azure-sas-signature',
      j(
        'https://x.blob.core.windows.net/c/b?sv=2024&',
        'sig=',
        'abcDEF123456ghiJKL789012mnoPQR345678%3D',
      ),
    ],
    ['application-insights-key', j('InstrumentationKey=', '4f3a2b1c-9d8e-4f7a-b6c5-1d2e3f4a5b6c')],
  ])('reports %s in any file, tests included', (rule, planted) => {
    for (const path of ['apps/api/src/config.ts', 'tests/security/x.test.ts', 'docs/setup.md']) {
      expect(rules(path, `const value = "${planted}";`)).toContain(rule);
    }
  });

  it.each([
    j('MOODLE_TOKEN=', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'),
    j('AZURE_OPENAI_API_KEY: ', '9f8e7d6c5b4a39281706f5e4d3c2b1a0'),
    j('TEAMS_BOT_CLIENT_SECRET="', 'Xy7~Q8.abcDEF-123456_ghiJKL', '"'),
    j('"clientSecret": "', 'Xy7~Q8.abcDEF-123456_ghiJKL', '"'),
    j("const apiKey = '", '9f8e7d6c5b4a39281706f5e4d3c2b1a0', "';"),
    j('password: ', 'Tr0ub4dor&3-correct-horse'),
  ])('reports a secret setting with a real-looking value', (line) => {
    expect(rules('infrastructure/environments/notes.md', line)).toEqual(['secret-assignment']);
    expect(rules('apps/api/src/thing.ts', line)).toEqual(['secret-assignment']);
  });

  it.each([
    'MOODLE_TOKEN=',
    'MOODLE_TOKEN=<your Moodle web-service token>',
    'MOODLE_TOKEN=${MOODLE_TOKEN}',
    "MOODLE_TOKEN: 'fake-moodle-token-0123456789abcdef'",
    'AZURE_OPENAI_API_KEY=example-key-not-real-000000',
    "{ name: 'MOODLE_TOKEN', secretName: 'moodle-token' }",
    'const apiKey = options.apiKey;',
    'password: process.env.DB_PASSWORD',
    'TEAMS_BOT_CLIENT_SECRET: secretString(16),',
    'api-key: [REDACTED]',
    'The client secret expires after 12 months.',
  ])('does not report the placeholder or reference "%s"', (line) => {
    expect(rules('docs/setup.md', line)).toEqual([]);
  });

  it('skips fake values in tests and fixtures, but not real-format credentials', () => {
    const assignment = j('MOODLE_TOKEN=', 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(rules('packages/x/src/__fixtures__/env.ts', assignment)).toEqual([]);
    expect(rules('packages/x/src/thing.test.ts', assignment)).toEqual([]);
    expect(
      rules('packages/x/src/thing.test.ts', j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')),
    ).toEqual(['github-token']);
  });

  it.each([
    '.env',
    '.env.local',
    'apps/api/.env.production',
    'certs/server.pem',
    'bot.pfx',
    'deploy.key',
    '.ssh/id_rsa',
  ])('reports the file %s whatever it contains', (path) => {
    expect(rules(path, '')).toEqual(['forbidden-file']);
  });

  it.each([
    '.env.example',
    'infrastructure/environments/test.env.example',
    'docs/environment.md',
    'keys.ts',
  ])('allows the file %s', (path) => {
    expect(rules(path, '')).toEqual([]);
  });

  it('reports where, never what', () => {
    const secret = j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    const findings = scanText('a.ts', `one\ntwo ${secret}\nthree`);
    expect(findings).toEqual([{ path: 'a.ts', line: 2, rule: 'github-token' }]);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });
});
