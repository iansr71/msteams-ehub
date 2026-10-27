import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * End-to-end: the real indexer CLI (config loading, HTTP transport, schemas, mapper, rendering)
 * against a local server imitating Moodle's REST endpoint with the phase 3 fixtures.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const fixtureDir = join(repoRoot, 'apps', 'indexer', 'src', 'moodle', '__fixtures__');
const TOKEN = 'clifaketoken0do0not0use0123456789';
const isolatedCwd = mkdtempSync(join(tmpdir(), 'ehub-indexer-cli-'));

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));

let server: Server;
let baseUrl: string;

function rewriteHost(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll('https://ehub.example.test', baseUrl));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname.startsWith('/webservice/pluginfile.php/')) {
        if (url.searchParams.get('token') !== TOKEN) {
          response.writeHead(403).end();
          return;
        }
        const chapter = /\/mod_book\/chapter\/(\d+)\/index\.html$/.exec(url.pathname)?.[1];
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          `<!DOCTYPE html><html><head><title>Chapter</title></head><body><h3>Introduction</h3><p>Chapter ${chapter ?? '?'} explains how skin analysis is recorded.</p><script>exfiltrate()</script></body></html>`,
        );
        return;
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      response.setHeader('content-type', 'application/json');
      if (form.get('wstoken') !== TOKEN) {
        response.end(
          JSON.stringify({
            exception: 'moodle_exception',
            errorcode: 'invalidtoken',
            message: 'Invalid token',
          }),
        );
        return;
      }
      switch (form.get('wsfunction')) {
        case 'core_webservice_get_site_info':
          response.end(JSON.stringify(rewriteHost(fixture('site-info'))));
          return;
        case 'core_course_get_courses': {
          const ids = [...form.entries()]
            .filter(([key]) => key.startsWith('options[ids]'))
            .map(([, v]) => Number(v));
          const courses = fixture('courses') as { id: number }[];
          response.end(
            JSON.stringify(ids.length === 0 ? courses : courses.filter((c) => ids.includes(c.id))),
          );
          return;
        }
        case 'core_course_get_contents':
          response.end(JSON.stringify(rewriteHost(fixture('contents-book'))));
          return;
        default:
          response.end(
            JSON.stringify({
              exception: 'webservice_access_exception',
              errorcode: 'accessexception',
              message: 'Access control exception',
            }),
          );
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
  rmSync(isolatedCwd, { recursive: true, force: true });
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Asynchronous spawn: the fake Moodle server runs in this process and must keep serving.
function runIndexer(args: string[], token = TOKEN): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      tsxBin,
      ['--conditions=@ehub/source', join(repoRoot, 'apps', 'indexer', 'src', 'cli.ts'), ...args],
      {
        cwd: isolatedCwd,
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'test',
          LOG_LEVEL: 'trace',
          MOODLE_BASE_URL: baseUrl,
          MOODLE_TOKEN: token,
          MOODLE_MAX_RETRIES: '0',
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

function expectNoToken(result: CliResult): void {
  expect(result.stdout).not.toContain(TOKEN);
  expect(result.stderr).not.toContain(TOKEN);
}

describe('indexer moodle:* CLI over HTTP', () => {
  it('moodle:ping succeeds and never prints the token, even at trace level', async () => {
    const result = await runIndexer(['moodle:ping', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ok', functions: { missing: [] } });
    expect(result.stderr).toContain('Moodle ping completed.');
    expectNoToken(result);
  });

  it('moodle:ping reports an invalid token as a sanitized failure', async () => {
    const wrong = 'wrongtokenvalue0123456789abcdef';
    const result = await runIndexer(['moodle:ping'], wrong);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('authentication / invalidtoken');
    expect(`${result.stdout}${result.stderr}`).not.toContain(wrong);
  });

  it('moodle:courses filters and returns JSON', async () => {
    const result = await runIndexer(['moodle:courses', '--search', 'consult', '--json']);
    expect(result.status).toBe(0);
    expect(
      (JSON.parse(result.stdout) as { courses: { id: number }[] }).courses.map((c) => c.id),
    ).toEqual([12]);
    expectNoToken(result);
  });

  it('moodle:inspect maps a Book end to end', async () => {
    const result = await runIndexer(['moodle:inspect', '--course-id', '12', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      summary: { resources: number };
      resources: { sourceUrl: string }[];
    };
    expect(parsed.summary.resources).toBe(4);
    expect(parsed.resources[0]?.sourceUrl.startsWith(`${baseUrl}/webservice/pluginfile.php/`)).toBe(
      true,
    );
    expectNoToken(result);
  });

  it('extract:test downloads with the token and prints only metadata and a short preview', async () => {
    const result = await runIndexer([
      'extract:test',
      '--course-id',
      '12',
      '--resource-id',
      '701:chapter:11',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      resource: { resourceType: string; sourceUrl: string };
      statistics: { blocks: number };
      preview: { text: string };
    };
    expect(parsed.status).toBe('extracted');
    expect(parsed.resource.resourceType).toBe('moodle-book-chapter');
    expect(parsed.resource.sourceUrl).not.toContain('token');
    expect(parsed.preview.text).toBe('Chapter 11 explains how skin analysis is recorded.');
    expect(result.stdout).not.toContain('exfiltrate');
    expectNoToken(result);
  });
});
