import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeEmbeddingService } from '../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import { startHttpsFetchServer, type HttpsFetchServer } from './helpers/httpsFakeSearch.js';

/*
 * End-to-end: the real `pnpm indexer embeddings:*` entry point (config loading, api-key header,
 * HTTPS transport, tokenizer limits, rendering) against a local HTTPS imitation of the Azure
 * OpenAI v1 embeddings endpoint.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const OPENAI_KEY = 'cliembeddingfakekey0do0not0use0123';
const SECRET_TEXT = 'Confidential consultation note for a client';

let fake: FakeEmbeddingService;
let server: HttpsFetchServer;

beforeAll(async () => {
  fake = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: 12 });
  server = await startHttpsFetchServer(fake.fetch);
});

afterAll(async () => {
  await server.close();
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(
      tsxBin,
      ['--conditions=@ehub/source', join(repoRoot, 'apps', 'indexer', 'src', 'cli.ts'), ...args],
      {
        cwd: server.workDir,
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'test',
          LOG_LEVEL: 'trace',
          NODE_EXTRA_CA_CERTS: server.certFile,
          AZURE_OPENAI_ENDPOINT: server.endpoint,
          AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed-deployment',
          AZURE_OPENAI_API_KEY: OPENAI_KEY,
          AZURE_OPENAI_EMBEDDING_DIMENSIONS: '12',
          EMBEDDING_MAX_RETRIES: '0',
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

function expectClean(result: CliResult): void {
  for (const text of [result.stdout, result.stderr]) {
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(SECRET_TEXT);
  }
}

describe('indexer embeddings:* CLI over HTTPS', () => {
  it('embeddings:health checks the deployment', async () => {
    const result = await run(['embeddings:health', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'healthy',
      embedding: { authMode: 'api-key', returnedDimensions: 12 },
    });
    expectClean(result);
    expect(fake.requests.at(-1)?.headers['api-key']).toBe(OPENAI_KEY);
    expect(fake.requests.at(-1)?.body.model).toBe('embed-deployment');
  });

  it('embeddings:test prints metadata and a preview, not the text or full vector', async () => {
    const result = await run(['embeddings:test', '--text', SECRET_TEXT, '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ dimensions: 12, modelIdentifier: 'text-embedding-3-small' });
    expect(parsed).not.toHaveProperty('vector');
    expect(result.stderr).toContain('Embeddings generated.');
    expectClean(result);
  });

  it('rejects text over the token limit before sending it', async () => {
    const before = fake.requests.length;
    const result = await run(['embeddings:test', '--text', 'word '.repeat(50)], {
      EMBEDDING_MAX_INPUT_TOKENS: '10',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('input_too_long');
    expect(fake.requests.length).toBe(before);
  });

  it('reports a wrong key as an authentication failure without printing it', async () => {
    const wrong = 'wrongopenaikey0123456789abcdefghij';
    const result = await run(['embeddings:health'], { AZURE_OPENAI_API_KEY: wrong });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Failure: authentication');
    expect(`${result.stdout}${result.stderr}`).not.toContain(wrong);
  });
});
