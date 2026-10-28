import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeSearchService } from '../../packages/shared/src/search/__fixtures__/fakeSearchService.js';

/*
 * End-to-end: the real indexer CLI (config loading, auth header, HTTPS transport, schema
 * comparison, rendering) against a local HTTPS server imitating Azure AI Search. The endpoint
 * must be https even in tests, so a throwaway self-signed certificate is trusted through
 * NODE_EXTRA_CA_CERTS for the child process only.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const API_KEY = 'clisearchfakekey0do0not0use0123456789';
const workDir = mkdtempSync(join(tmpdir(), 'ehub-search-cli-'));
const certFile = join(workDir, 'cert.pem');
const keyFile = join(workDir, 'key.pem');

let server: Server;
let endpoint: string;
let service: FakeSearchService;

beforeAll(async () => {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdio: 'ignore' },
  );
  service = new FakeSearchService({ apiKey: API_KEY });
  server = createServer(
    { cert: readFileSync(certFile), key: readFileSync(keyFile) },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'https://127.0.0.1');
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') {
            headers[name] = value;
          }
        }
        const result = service.handle({
          method: request.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(result.status, result.headers ?? {});
        response.end(result.body ?? '');
      });
    },
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  endpoint = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
  rmSync(workDir, { recursive: true, force: true });
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runIndexer(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      tsxBin,
      ['--conditions=@ehub/source', join(repoRoot, 'apps', 'indexer', 'src', 'cli.ts'), ...args],
      {
        cwd: workDir,
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'test',
          LOG_LEVEL: 'trace',
          NODE_EXTRA_CA_CERTS: certFile,
          AZURE_SEARCH_ENDPOINT: endpoint,
          AZURE_SEARCH_API_KEY: API_KEY,
          AZURE_SEARCH_VECTOR_DIMENSIONS: '1536',
          AZURE_SEARCH_MAX_RETRIES: '0',
          ...extraEnv,
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

function expectNoKey(result: CliResult): void {
  expect(result.stdout).not.toContain(API_KEY);
  expect(result.stderr).not.toContain(API_KEY);
}

describe('indexer search:* CLI over HTTPS', () => {
  it('validate-index reports a missing index', async () => {
    const result = await runIndexer(['search:validate-index', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      indexName: 'ehub-course-content-v1',
      status: 'missing',
    });
    expectNoKey(result);
  });

  it('create-index creates the index with the api-key header, then validates', async () => {
    const created = await runIndexer(['search:create-index']);
    expect(created.status).toBe(0);
    expect(created.stdout.trim()).toBe('Index ehub-course-content-v1 created.');
    expect(created.stderr).toContain('Search index created.');
    expectNoKey(created);
    const put = service.requests.find((request) => request.method === 'PUT');
    expect(put?.headers['api-key']).toBe(API_KEY);
    expect(put?.query.get('api-version')).toBe('2026-04-01');

    const validated = await runIndexer(['search:validate-index']);
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain('OK (matches this version)');
  });

  it('health reports the index and service counters', async () => {
    const result = await runIndexer(['search:health', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'healthy',
      authMode: 'api-key',
      index: { exists: true, documentCount: 0 },
    });
    expectNoKey(result);
  });

  it('refuses an incompatible change and leaves the index untouched', async () => {
    const puts = service.requests.filter((request) => request.method === 'PUT').length;
    const result = await runIndexer(['search:create-index', '--apply-compatible-changes'], {
      AZURE_SEARCH_VECTOR_DIMENSIONS: '3072',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('needs a migration');
    expect(service.requests.filter((request) => request.method === 'PUT')).toHaveLength(puts);
  });

  it('reports a wrong key as an authentication failure without printing either key', async () => {
    const wrong = 'wrongsearchkey0123456789abcdefghij';
    const result = await runIndexer(['search:health'], { AZURE_SEARCH_API_KEY: wrong });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Failure: authentication');
    expect(result.stdout).toContain('Hint: Locally, check AZURE_SEARCH_API_KEY');
    expect(`${result.stdout}${result.stderr}`).not.toContain(wrong);
    expectNoKey(result);
  });

  it('rejects an http endpoint before any request is made', async () => {
    const before = service.requests.length;
    const result = await runIndexer(['search:health'], {
      AZURE_SEARCH_ENDPOINT: endpoint.replace('https:', 'http:'),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('AZURE_SEARCH_ENDPOINT');
    expect(service.requests.length).toBe(before);
  });
});
