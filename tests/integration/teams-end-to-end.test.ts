import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  corpus,
  SECRET_SENTENCE,
  TENANT_ID,
} from '../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { modelAnswer } from '../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import { FakeEmbeddingService } from '../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import { buildIndexDefinition } from '../../packages/shared/src/search/indexDefinition.js';
import {
  startHttpsFakeSearch,
  startHttpsFetchServer,
  type HttpsFakeSearch,
  type HttpsFetchServer,
} from './helpers/httpsFakeSearch.js';

/*
 * End to end, as separate processes: a Teams activity is posted to the real bot
 * (`apps/teams-app/src/main.ts`, development mode, unsigned requests allowed as with
 * Microsoft 365 Agents Playground), which calls the real answer API (`pnpm api serve`) over
 * HTTP, which uses retrieval and chat against HTTPS imitations of Azure AI Search and Azure
 * OpenAI. The bot's replies go to a local imitation of the Bot Connector service.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const SEARCH_KEY = 'e2esearchfakekey0do0not0use012345';
const OPENAI_KEY = 'e2eopenaifakekey0do0not0use012345';
const QUESTION = 'Quokka-lantern: how often should sunscreen be reapplied after a peel?';

let search: HttpsFakeSearch;
let openai: HttpsFetchServer;
let connector: Server;
let connectorUrl: string;
const posted: { type: string; attachments?: { content: unknown }[] }[] = [];
const processes: { child: ChildProcess; stdout: string[]; stderr: string[] }[] = [];
let apiPort: number;
let botPort: number;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
  return port;
}

function launch(
  script: string,
  args: string[],
  env: Record<string, string>,
  ready: RegExp,
): Promise<(typeof processes)[number]> {
  return new Promise((done, fail) => {
    const child = spawn(tsxBin, ['--conditions=@ehub/source', join(repoRoot, script), ...args], {
      cwd: search.workDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        LOG_LEVEL: 'debug',
        NODE_EXTRA_CA_CERTS: join(search.workDir, 'both.pem'),
        ...env,
      },
    });
    const entry = { child, stdout: [] as string[], stderr: [] as string[] };
    processes.push(entry);
    const timer = setTimeout(() => {
      fail(
        new Error(
          `${script} did not start: ${entry.stdout.join('')} ${entry.stderr.join('').slice(-2000)}`,
        ),
      );
    }, 25_000);
    child.stdout.on('data', (chunk: Buffer) => {
      entry.stdout.push(chunk.toString('utf8'));
      if (ready.test(entry.stdout.join(''))) {
        clearTimeout(timer);
        done(entry);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => entry.stderr.push(chunk.toString('utf8')));
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!ready.test(entry.stdout.join(''))) {
        fail(new Error(`${script} exited with ${String(code)}: ${entry.stdout.join('')}`));
      }
    });
  });
}

beforeAll(async () => {
  search = await startHttpsFakeSearch(SEARCH_KEY);
  search.service.handle({
    method: 'PUT',
    path: '/indexes/ehub-course-content-v1',
    query: new URLSearchParams({ 'api-version': '2026-04-01' }),
    headers: { 'api-key': SEARCH_KEY },
    body: JSON.stringify(
      buildIndexDefinition({
        indexName: 'ehub-course-content-v1',
        vectorDimensions: 8,
        semanticEnabled: true,
      }),
    ),
  });
  search.service.seed('ehub-course-content-v1', corpus());
  const embeddings = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: 8 });
  openai = await startHttpsFetchServer((url, init) =>
    url.endsWith('/openai/v1/embeddings')
      ? embeddings.fetch(url, init)
      : Promise.resolve(
          Response.json({
            model: 'gpt-test',
            choices: [{ finish_reason: 'stop', message: { content: modelAnswer() } }],
            usage: {},
          }),
        ),
  );
  writeFileSync(
    join(search.workDir, 'both.pem'),
    `${readFileSync(search.certFile, 'utf8')}\n${readFileSync(openai.certFile, 'utf8')}`,
  );

  connector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (/\/v3\/conversations\/[^/]+\/activities/.test(request.url ?? '')) {
        posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof posted)[number]);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":"sent"}');
    });
  });
  await new Promise<void>((done) => connector.listen(0, '127.0.0.1', done));
  connectorUrl = `http://127.0.0.1:${String((connector.address() as AddressInfo).port)}`;

  apiPort = await freePort();
  botPort = await freePort();
  await launch(
    'apps/api/src/cli.ts',
    ['serve'],
    {
      NODE_ENV: 'development',
      PORT: String(apiPort),
      API_DEV_MOCK_IDENTITY: 'true',
      API_DEV_MOCK_COURSE_IDS: '12',
      MOODLE_BASE_URL: 'https://ehub.example.test',
      AZURE_SEARCH_ENDPOINT: search.endpoint,
      AZURE_SEARCH_API_KEY: SEARCH_KEY,
      AZURE_SEARCH_VECTOR_DIMENSIONS: '8',
      AZURE_SEARCH_MAX_RETRIES: '0',
      AZURE_TENANT_ID: TENANT_ID,
      AZURE_OPENAI_ENDPOINT: openai.endpoint,
      AZURE_OPENAI_API_KEY: OPENAI_KEY,
      AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat-deployment',
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed-deployment',
      AZURE_OPENAI_EMBEDDING_DIMENSIONS: '8',
      EMBEDDING_MAX_RETRIES: '0',
      CHAT_MAX_RETRIES: '0',
    },
    /Answer API listening/,
  );
  await launch(
    'apps/teams-app/src/main.ts',
    [],
    {
      NODE_ENV: 'development',
      TEAMS_BOT_PORT: String(botPort),
      TEAMS_DEV_ALLOW_UNAUTHENTICATED: 'true',
      TEAMS_DEV_MOCK_IDENTITY: 'true',
      TEAMS_API_BASE_URL: `http://127.0.0.1:${String(apiPort)}`,
      TEAMS_ALLOWED_LINK_HOSTS: 'ehub.example.test',
    },
    /bot listening on port/,
  );
}, 60_000);

afterAll(async () => {
  for (const { child } of processes) {
    child.kill('SIGTERM');
  }
  await search.close();
  await openai.close();
  await new Promise<void>((done) => {
    connector.closeAllConnections();
    connector.close(() => {
      done();
    });
  });
});

function deliver(body: unknown): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((done, fail) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: botPort,
        path: '/api/messages',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          done({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', fail);
    request.end(payload);
  });
}

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id: `e2e-${String(Math.random()).slice(2)}`,
    channelId: 'msteams',
    serviceUrl: connectorUrl,
    from: { id: '29:user', name: 'Branch user' },
    recipient: { id: '28:bot', name: 'E-Hub' },
    conversation: { id: 'a:e2e', conversationType: 'personal' },
    text: QUESTION,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting.');
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

describe('Teams → answer API → RAG', () => {
  it('answers a question with an Adaptive Card citing the authorised course', async () => {
    const response = await deliver(activity());
    expect(response.status).toBe(200);
    await waitFor(() => posted.some((entry) => entry.type === 'message'));
    const card = JSON.stringify(
      posted.find((entry) => entry.type === 'message')?.attachments?.[0]?.content,
    );
    expect(card).toContain('Sources');
    expect(card).toContain('Open in E-Hub');
    expect(card).toContain('https://ehub.example.test/');
    expect(card).toContain('Development mode');

    // One correlation ID from the bot's turn to the API's request.
    const [bot, api] = [processes[1], processes[0]];
    const botLine =
      bot?.stderr
        .join('')
        .split('\n')
        .find((line) => line.includes('Answer sent.')) ?? '';
    const correlationId = (JSON.parse(botLine) as { correlationId: string }).correlationId;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(api?.stderr.join('')).toContain(`"correlationId":"${correlationId}"`);
    expect(card).toContain(`Reference: ${correlationId}`);
  });

  it('records feedback through the API', async () => {
    const response = await deliver(
      activity({
        type: 'invoke',
        name: 'adaptiveCard/action',
        text: undefined,
        value: {
          action: {
            type: 'Action.Execute',
            verb: 'ehub.feedback',
            data: { ehubAction: 'feedback', answerId: 'e2e-answer-1', rating: 'useful' },
          },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({
      value: 'Thanks — your feedback was recorded.',
    });
    await waitFor(
      () => processes[0]?.stderr.join('').includes('Answer feedback received.') ?? false,
    );
  });

  it('logs no question, passage or credential in either process', () => {
    for (const { stdout, stderr } of processes) {
      const text = `${stdout.join('')}${stderr.join('')}`;
      expect(text).not.toContain('Quokka-lantern');
      expect(text).not.toContain(SECRET_SENTENCE);
      expect(text).not.toContain(SEARCH_KEY);
      expect(text).not.toContain(OPENAI_KEY);
    }
  });
});
