import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeEmbeddingService } from '../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import {
  startHttpsFakeSearch,
  startHttpsFetchServer,
  type HttpsFakeSearch,
  type HttpsFetchServer,
} from './helpers/httpsFakeSearch.js';

/*
 * End-to-end: the real `pnpm indexer sync:*` commands against a local Moodle (HTTP, allowed
 * outside production) and HTTPS imitations of Azure AI Search and Azure OpenAI embeddings. The
 * course has an HTML Page and a PDF, the two content types E-Hub uses.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const TOKEN = 'clisyncmoodletoken0do0not0use01234';
const SEARCH_KEY = 'clisyncsearchfakekey0do0not0use0123';
const OPENAI_KEY = 'clisyncopenaifakekey0do0not0use0123';
const TENANT = '00000000-0000-4000-8000-0000000000cc';
const SECRET = 'Quokka-lantern aftercare: reapply SPF 50 every ninety minutes';
const PDF = readFileSync(
  join(repoRoot, 'apps', 'indexer', 'src', 'extractors', '__fixtures__', 'sample.pdf'),
);

let moodle: Server;
let moodleUrl: string;
let search: HttpsFakeSearch;
let openai: HttpsFetchServer;
let pageListed = true;

function contents(): unknown[] {
  const page = {
    id: 601,
    name: 'Peel aftercare',
    modname: 'page',
    url: `${moodleUrl}/mod/page/view.php?id=601`,
    visible: 1,
    uservisible: true,
    contents: [
      {
        type: 'file',
        filename: 'index.html',
        filepath: '/',
        filesize: 0,
        fileurl: `${moodleUrl}/webservice/pluginfile.php/5601/mod_page/content/1/index.html?forcedownload=1`,
        timemodified: 1_770_000_000,
        sortorder: 1,
      },
    ],
  };
  const pdf = {
    id: 702,
    name: 'Aftercare leaflet',
    modname: 'resource',
    url: `${moodleUrl}/mod/resource/view.php?id=702`,
    visible: 1,
    uservisible: true,
    contents: [
      {
        type: 'file',
        filename: 'Aftercare.pdf',
        filepath: '/',
        filesize: PDF.byteLength,
        fileurl: `${moodleUrl}/webservice/pluginfile.php/5702/mod_resource/content/1/Aftercare.pdf?forcedownload=1`,
        mimetype: 'application/pdf',
        timemodified: 1_770_000_000,
        sortorder: 1,
      },
    ],
  };
  return [
    {
      id: 120,
      name: 'General',
      section: 0,
      visible: 1,
      uservisible: true,
      modules: pageListed ? [page, pdf] : [pdf],
    },
  ];
}

beforeAll(async () => {
  moodle = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname.startsWith('/webservice/pluginfile.php/')) {
        if (url.searchParams.get('token') !== TOKEN) {
          response.writeHead(403).end();
          return;
        }
        if (url.pathname.endsWith('/Aftercare.pdf')) {
          response.writeHead(200, { 'content-type': 'application/pdf' });
          response.end(PDF);
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          `<h2>Peel aftercare</h2><p>${SECRET}</p><p>Avoid exfoliants for seven days.</p>`,
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
        case 'core_course_get_courses':
          response.end(
            JSON.stringify([
              {
                id: 12,
                shortname: 'CS',
                fullname: 'Consultation Standards',
                categoryid: 3,
                format: 'topics',
                visible: 1,
              },
            ]),
          );
          return;
        case 'core_course_get_contents':
          response.end(JSON.stringify(contents()));
          return;
        default:
          response.end(
            JSON.stringify({
              exception: 'webservice_access_exception',
              errorcode: 'accessexception',
              message: 'x',
            }),
          );
      }
    });
  });
  await new Promise<void>((done) => moodle.listen(0, '127.0.0.1', done));
  moodleUrl = `http://127.0.0.1:${String((moodle.address() as AddressInfo).port)}`;

  search = await startHttpsFakeSearch(SEARCH_KEY);
  const embeddings = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: 8 });
  openai = await startHttpsFetchServer((url, init) => embeddings.fetch(url, init));
  writeFileSync(
    join(search.workDir, 'both.pem'),
    `${readFileSync(search.certFile, 'utf8')}\n${readFileSync(openai.certFile, 'utf8')}`,
  );
});

afterAll(async () => {
  await new Promise<void>((done) => {
    moodle.close(() => {
      done();
    });
  });
  await search.close();
  await openai.close();
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      tsxBin,
      ['--conditions=@ehub/source', join(repoRoot, 'apps', 'indexer', 'src', 'cli.ts'), ...args],
      {
        cwd: search.workDir,
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'test',
          LOG_LEVEL: 'debug',
          NODE_EXTRA_CA_CERTS: join(search.workDir, 'both.pem'),
          MOODLE_BASE_URL: moodleUrl,
          MOODLE_TOKEN: TOKEN,
          MOODLE_MAX_RETRIES: '0',
          AZURE_SEARCH_ENDPOINT: search.endpoint,
          AZURE_SEARCH_API_KEY: SEARCH_KEY,
          AZURE_SEARCH_VECTOR_DIMENSIONS: '8',
          AZURE_SEARCH_MAX_RETRIES: '0',
          AZURE_OPENAI_ENDPOINT: openai.endpoint,
          AZURE_OPENAI_API_KEY: OPENAI_KEY,
          AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed-deployment',
          AZURE_OPENAI_EMBEDDING_DIMENSIONS: '8',
          EMBEDDING_MAX_RETRIES: '0',
          AZURE_TENANT_ID: TENANT,
          SYNC_COURSE_IDS: '12',
          ...env,
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
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SEARCH_KEY);
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain('Quokka-lantern');
  }
}

const docs = () => [...(search.service.documents.get('ehub-course-content-v1')?.values() ?? [])];

describe('pnpm indexer sync:*', () => {
  it('refuses to run before the index exists', async () => {
    const result = await run(['sync:incremental']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('index_missing');
    expect(result.stdout).toContain('search:create-index');
    expectClean(result);
  });

  it('creates the index, then a dry run plans without changing anything', async () => {
    expect((await run(['search:create-index'])).status).toBe(0);
    const result = await run(['sync:full', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry run');
    expect(result.stdout).toContain('would_index');
    expect(docs()).toHaveLength(0);
    expect(existsSync(join(search.workDir, '.ehub', 'sync-state', 'jobs.json'))).toBe(false);
    expectClean(result);
  });

  it('indexes the HTML page and the PDF, then skips them', async () => {
    const first = await run(['sync:incremental', '--json']);
    expect(first.status).toBe(0);
    const report = JSON.parse(first.stdout) as { status: string; counts: Record<string, number> };
    expect(report).toMatchObject({
      status: 'succeeded',
      counts: { processed: 2, updated: 2, failed: 0 },
    });
    expect(new Set(docs().map((doc) => doc['resourceType']))).toEqual(
      new Set(['moodle-page', 'pdf']),
    );
    expect(docs().every((doc) => doc['tenantId'] === TENANT && doc['courseId'] === 12)).toBe(true);
    expect(existsSync(join(search.workDir, '.ehub', 'sync-state', 'jobs.json'))).toBe(true);
    expect(first.stderr).toContain('"jobId"');
    expect(first.stderr).toContain('"correlationId"');
    expectClean(first);

    const second = await run(['sync:incremental']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Processed 2 | skipped 2 | updated 0 | removed 0 | failed 0');
    expectClean(second);
  });

  it('reconciles a deleted page: dry run first, then for real', async () => {
    pageListed = false;
    const dry = await run(['sync:reconcile', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would_remove');
    expect(docs().some((doc) => doc['resourceId'] === '601:page')).toBe(true);

    const real = await run(['sync:reconcile']);
    expect(real.status).toBe(0);
    expect(real.stdout).toContain('removed');
    expect(docs().some((doc) => doc['resourceId'] === '601:page')).toBe(false);
    expect(docs().some((doc) => doc['resourceId'] === '702:file:/Aftercare.pdf')).toBe(true);
    expectClean(real);
    pageListed = true;
  });

  it('syncs one resource and rejects bad usage', async () => {
    const one = await run(['sync:resource', '--course-id', '12', '--resource-id', '601:page']);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain('indexed');

    expect((await run(['sync:full', '--course-id', '12'])).status).toBe(2);
    expect((await run(['sync:course', '--course-id', '99'])).status).toBe(2);
    const unselected = await run(['sync:incremental'], { SYNC_COURSE_IDS: '' });
    expect(unselected.status).toBe(2);
    expect(unselected.stdout).toContain('SYNC_COURSE_IDS');
    const missing = await run(['sync:resource', '--course-id', '12', '--resource-id', '999:page']);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('resource_not_found');
  });
});
