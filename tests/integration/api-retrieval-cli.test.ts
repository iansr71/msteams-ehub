import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  corpus,
  SECRET_SENTENCE,
  TENANT_ID,
} from '../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { buildIndexDefinition } from '../../packages/shared/src/search/indexDefinition.js';
import { startHttpsFakeSearch, type HttpsFakeSearch } from './helpers/httpsFakeSearch.js';

/*
 * End-to-end: the real `pnpm api retrieve` and `pnpm evaluation retrieval` entry points
 * (config loading, auth header, HTTPS transport, filters, rendering) against a local HTTPS
 * imitation of Azure AI Search, using the shipped template evaluation file.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const API_KEY = 'cliretrievalfakekey0do0not0use012345';

let fake: HttpsFakeSearch;

beforeAll(async () => {
  fake = await startHttpsFakeSearch(API_KEY);
  const definition = buildIndexDefinition({
    indexName: 'ehub-course-content-v1',
    vectorDimensions: 8,
    semanticEnabled: true,
  });
  fake.service.handle({
    method: 'PUT',
    path: '/indexes/ehub-course-content-v1',
    query: new URLSearchParams({ 'api-version': '2026-04-01' }),
    headers: { 'api-key': API_KEY },
    body: JSON.stringify(definition),
  });
  fake.service.seed('ehub-course-content-v1', corpus());
});

afterAll(async () => {
  await fake.close();
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(entry: 'cli.ts' | 'evaluationCli.ts', args: string[]): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      tsxBin,
      ['--conditions=@ehub/source', join(repoRoot, 'apps', 'api', 'src', entry), ...args],
      {
        cwd: fake.workDir,
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'test',
          LOG_LEVEL: 'trace',
          NODE_EXTRA_CA_CERTS: fake.certFile,
          // pnpm sets INIT_CWD to where the user ran it; file paths resolve against it.
          INIT_CWD: repoRoot,
          AZURE_SEARCH_ENDPOINT: fake.endpoint,
          AZURE_SEARCH_API_KEY: API_KEY,
          AZURE_SEARCH_VECTOR_DIMENSIONS: '8',
          AZURE_SEARCH_MAX_RETRIES: '0',
          AZURE_TENANT_ID: TENANT_ID,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('CLI timed out'));
    }, 25_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

function expectClean(result: CliResult): void {
  for (const text of [result.stdout, result.stderr]) {
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET_SENTENCE);
  }
}

describe('api retrieval CLIs over HTTPS', () => {
  it('pnpm api retrieve returns only the authorised course and logs no question text', async () => {
    const result = await run('cli.ts', [
      'retrieve',
      '--question',
      'laser eye protection goggles',
      '--course-id',
      '12',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      results: { courseId: number; resourceId: string }[];
    };
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.every((entry) => entry.courseId === 12)).toBe(true);
    expect(result.stderr).toContain('Retrieval completed.');
    expect(result.stderr).not.toContain('laser eye protection goggles');
    expectClean(result);
    const search = fake.service.requests
      .filter((request) => request.path.endsWith('/docs/search'))
      .at(-1);
    expect(search?.headers['api-key']).toBe(API_KEY);
    expect(JSON.parse(search?.body ?? '{}')).toMatchObject({
      filter: `tenantId eq '${TENANT_ID}' and isActive eq true and (courseId eq 12)`,
    });
  });

  it('pnpm evaluation retrieval runs the template file and prints the metrics', async () => {
    const result = await run('evaluationCli.ts', [
      'retrieval',
      '--file',
      'tests/evaluation/retrieval-cases.json',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS case-001 first expected at rank 1');
    expect(result.stdout).toContain('PASS case-002');
    expect(result.stdout).toContain('Hit@1 100.0% | Hit@3 100.0% | Hit@5 100.0% | MRR 1.000');
    expectClean(result);
  });

  it('refuses to run retrieval without an authorised course', async () => {
    const before = fake.service.requests.length;
    const result = await run('cli.ts', ['retrieve', '--question', 'x']);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('--course-id: is required.');
    expect(fake.service.requests.length).toBe(before);
  });
});
