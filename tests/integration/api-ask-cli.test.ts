import { spawn } from 'node:child_process';
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
 * End-to-end: the real `pnpm api ask` entry point against local HTTPS imitations of Azure AI
 * Search and Azure OpenAI (embeddings and chat on one endpoint, as in Azure).
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const SEARCH_KEY = 'cliasksearchfakekey0do0not0use0123';
const OPENAI_KEY = 'cliaskopenaifakekey0do0not0use0123';
const QUESTION = 'How often should sunscreen be reapplied after a peel?';

let search: HttpsFakeSearch;
let openai: HttpsFetchServer;
const chatBodies: { messages: { role: string; content: string }[] }[] = [];
let chatReplies: string[] = [];

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
  openai = await startHttpsFetchServer(async (url, init) => {
    if (url.endsWith('/openai/v1/embeddings')) {
      return embeddings.fetch(url, init);
    }
    const headers = new Headers(init.headers);
    if (headers.get('api-key') !== OPENAI_KEY) {
      return Response.json({ error: { code: '401' } }, { status: 401 });
    }
    chatBodies.push(
      JSON.parse(typeof init.body === 'string' ? init.body : '{}') as (typeof chatBodies)[number],
    );
    const content = chatReplies.shift() ?? modelAnswer();
    return Promise.resolve(
      Response.json({
        model: 'gpt-test',
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: {},
      }),
    );
  });
});

afterAll(async () => {
  await search.close();
  await openai.close();
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: string[]): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      tsxBin,
      ['--conditions=@ehub/source', join(repoRoot, 'apps', 'api', 'src', 'cli.ts'), ...args],
      {
        cwd: search.workDir,
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'test',
          LOG_LEVEL: 'trace',
          // Both throwaway certificates must be trusted.
          NODE_EXTRA_CA_CERTS: join(search.workDir, 'both.pem'),
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
    expect(text).not.toContain(SEARCH_KEY);
    expect(text).not.toContain(OPENAI_KEY);
  }
  expect(result.stderr).not.toContain(QUESTION);
  expect(result.stderr).not.toContain(SECRET_SENTENCE);
}

describe('pnpm api ask over HTTPS', () => {
  beforeAll(async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(
      join(search.workDir, 'both.pem'),
      `${readFileSync(search.certFile, 'utf8')}\n${readFileSync(openai.certFile, 'utf8')}`,
    );
  });

  it('answers from the authorised course with hybrid retrieval and logs no text', async () => {
    const result = await run(['ask', '--question', QUESTION, '--course-id', '12', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      retrieval: { mode: string };
      sources: { courseId: number }[];
    };
    expect(parsed).toMatchObject({ status: 'answered', retrieval: { mode: 'hybrid' } });
    expect(parsed.sources.every((source) => source.courseId === 12)).toBe(true);
    expect(result.stderr).toContain('Question answered.');
    expectClean(result);
    const prompt =
      chatBodies.at(-1)?.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(prompt).toContain(SECRET_SENTENCE);
    expect(prompt).not.toContain('Laser treatments require eye protection');
  });

  it('returns a safe failure when the model output stays malformed', async () => {
    chatReplies = ['not json', 'still not json'];
    const result = await run(['ask', '--question', QUESTION, '--course-id', '12']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Status: failed (invalid_output)');
    expectClean(result);
  });
});
