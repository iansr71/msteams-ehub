import type { MoodleDownloadedFile, MoodleFileDownloader } from '@ehub/moodle-client';
import { createLogger, type CommandContext } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import { loadBinary } from '../extractors/__fixtures__/helpers.js';
import { fixtureClient, type ContentsFixture } from '../moodle/__fixtures__/fixtureClient.js';
import { createEmbeddingProvider } from '@ehub/shared/embeddings';

import { FakeEmbeddingService } from '../../../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import { createChunkTestCommand } from './chunkCommand.js';

const env = {
  MOODLE_BASE_URL: 'https://ehub.example.test',
  MOODLE_TOKEN: 'chunktestfaketoken0123456789abcd',
};

function downloader(bytes: Uint8Array, contentType: string): MoodleFileDownloader {
  return {
    download: (url) => {
      const file: MoodleDownloadedFile = {
        sourceUrl: url,
        finalUrl: url,
        redirectCount: 0,
        contentType,
        lastModified: undefined,
        byteLength: bytes.byteLength,
        bytes,
      };
      return Promise.resolve(file);
    },
  };
}

async function run(
  args: string[],
  options: {
    contents?: ContentsFixture;
    bytes?: Uint8Array;
    contentType?: string;
    env?: Record<string, string>;
  } = {},
) {
  const fixture = fixtureClient({ contents: options.contents ?? 'contents-pdf-resource' });
  const embeddings = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: 8 });
  const output: string[] = [];
  const logs: string[] = [];
  const context: CommandContext = {
    args,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logs.push(line) },
    }),
    stdout: (text) => output.push(text),
  };
  const exitCode = await createChunkTestCommand(
    {
      env: options.env ?? env,
      createAccess: (settings) => ({
        client: fixture.client,
        baseUrl: fixture.baseUrl,
        downloader: downloader(
          options.bytes ?? loadBinary('sample.pdf'),
          options.contentType ?? 'application/pdf',
        ),
        settings,
      }),
    },
    {
      env: options.env ?? env,
      createEmbedder: (settings) => createEmbeddingProvider(settings, { fetch: embeddings.fetch }),
    },
  ).run(context);
  return { exitCode, stdout: output.join('\n'), logs: logs.join('\n'), embeddings };
}

const PDF = ['--course-id', '12', '--resource-id', '501:file:/checklist.pdf'];
const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';

describe('chunk:test --embed', () => {
  const embeddingEnv = {
    ...env,
    AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
    AZURE_OPENAI_API_KEY: OPENAI_KEY,
    AZURE_OPENAI_EMBEDDING_DIMENSIONS: '8',
  };

  it('embeds the chunks and validates their index documents without printing vectors', async () => {
    const result = await run([...PDF, '--embed', '--json'], { env: embeddingEnv });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { embedding: Record<string, unknown> };
    expect(parsed.embedding).toEqual({
      model: 'text-embedding-3-small',
      version: '1',
      dimensions: 8,
      documents: 3,
      generated: 3,
      cached: 0,
    });
    expect(result.embeddings.requests).toHaveLength(1);
    expect(result.stdout).not.toMatch(/contentVector|"vector"/);
    expect(result.stdout + result.logs).not.toContain(OPENAI_KEY);
  });

  it('reports missing embedding configuration by variable name', async () => {
    const result = await run([...PDF, '--embed']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('AZURE_OPENAI_ENDPOINT: Required.');
  });
});

describe('chunk:test', () => {
  it('shows chunk numbers, token counts, locations and source metadata', async () => {
    const result = await run(PDF);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Chunking: 3 chunks (structure-aware@1.0.0, tokenizer cl100k_base; target 850 / max 1000 / min 100 / overlap 125)',
    );
    expect(result.stdout).toContain('Course:    12 Consultation Standards (category 3)');
    expect(result.stdout).toMatch(/\n {3}1 +\d+ +0 {2}p1 +[0-9a-f]{12} {2}Consultation checklist/);
    expect(result.stdout).toContain('AZURE_TENANT_ID is not set');
  });

  it('never prints chunk text unless a preview is requested, and then only 60 characters', async () => {
    const body = `<h1>Protocol</h1><p>${'Confidential treatment detail. '.repeat(300)}</p>`;
    const options = {
      contents: 'contents-page' as const,
      bytes: new TextEncoder().encode(body),
      contentType: 'text/html',
    };
    const plain = await run(['--course-id', '12', '--resource-id', '601:page'], options);
    expect(plain.stdout).not.toContain('Confidential treatment detail');

    const withPreview = await run(
      ['--course-id', '12', '--resource-id', '601:page', '--preview', '--json'],
      options,
    );
    const parsed = JSON.parse(withPreview.stdout) as { chunks: { preview: string }[] };
    expect(parsed.chunks.length).toBeGreaterThan(1);
    expect(parsed.chunks.every((chunk) => chunk.preview.length <= 60)).toBe(true);
    expect(plain.logs + withPreview.logs).not.toContain('Confidential treatment detail');
  });

  it('outputs JSON with settings, statistics and per-chunk rows but no content field', async () => {
    const result = await run([...PDF, '--json']);
    const parsed = JSON.parse(result.stdout) as {
      settings: Record<string, unknown>;
      statistics: { chunks: number; maxTokens: number };
      chunks: Record<string, unknown>[];
    };
    expect(parsed.settings).toMatchObject({
      targetTokens: 850,
      maxTokens: 1000,
      minTokens: 100,
      overlapTokens: 125,
      tokenizer: 'cl100k_base',
      tenantId: 'local-diagnostic',
    });
    expect(parsed.statistics.chunks).toBe(parsed.chunks.length);
    expect(parsed.statistics.maxTokens).toBeLessThanOrEqual(1000);
    for (const chunk of parsed.chunks) {
      expect(chunk).not.toHaveProperty('content');
      expect(chunk['chunkId']).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('uses configured chunk settings and the configured tenant', async () => {
    const result = await run([...PDF, '--json'], {
      env: {
        ...env,
        CHUNK_TARGET_TOKENS: '400',
        CHUNK_MAX_TOKENS: '500',
        CHUNK_MIN_TOKENS: '50',
        CHUNK_OVERLAP_TOKENS: '0',
        CHUNK_TOKENIZER: 'o200k_base',
        AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000001',
      },
    });
    const parsed = JSON.parse(result.stdout) as {
      settings: Record<string, unknown>;
      notes: string[];
    };
    expect(parsed.settings).toMatchObject({
      targetTokens: 400,
      maxTokens: 500,
      tokenizer: 'o200k_base',
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
    expect(parsed.notes.some((note) => note.includes('AZURE_TENANT_ID'))).toBe(false);
  });

  it('reports inconsistent chunk settings by variable name', async () => {
    const result = await run(PDF, { env: { ...env, CHUNK_MIN_TOKENS: '900' } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('CHUNK_MIN_TOKENS: Must be less than CHUNK_TARGET_TOKENS.');
  });

  it('shows the extraction result when extraction fails', async () => {
    const result = await run([...PDF, '--json'], { bytes: loadBinary('encrypted.pdf') });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'failed', reason: 'encrypted' });
  });

  it('does not download a resource discovery marked unsupported', async () => {
    const result = await run(
      ['--course-id', '12', '--resource-id', '801:file:/logo.png', '--json'],
      { contents: 'contents-multiple-files' },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'unsupported',
      warnings: ['not_downloaded'],
    });
  });

  it('labels PowerPoint chunks by slide', async () => {
    const result = await run(['--course-id', '12', '--resource-id', '501:file:/checklist.pdf'], {
      bytes: loadBinary('sample.pptx'),
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(result.stdout).toContain('slide 1');
    expect(result.stdout).toContain('slide 3');
  });
});
