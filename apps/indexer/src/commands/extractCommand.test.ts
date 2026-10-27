import type { MoodleDownloadedFile, MoodleFileDownloader } from '@ehub/moodle-client';
import { createLogger, type CommandContext } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import { loadBinary } from '../extractors/__fixtures__/helpers.js';
import { fixtureClient, type ContentsFixture } from '../moodle/__fixtures__/fixtureClient.js';
import { createExtractTestCommand } from './extractCommand.js';

const env = {
  MOODLE_BASE_URL: 'https://ehub.example.test',
  MOODLE_TOKEN: 'extracttestfaketoken0123456789ab',
};

function fakeDownloader(bytes: Uint8Array, contentType = 'application/pdf') {
  const requested: string[] = [];
  const downloader: MoodleFileDownloader = {
    download: (url) => {
      requested.push(url);
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
  return { downloader, requested };
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
  const fake = fakeDownloader(options.bytes ?? loadBinary('sample.pdf'), options.contentType);
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
  const exitCode = await createExtractTestCommand({
    env: options.env ?? env,
    createAccess: (settings) => ({
      client: fixture.client,
      baseUrl: fixture.baseUrl,
      downloader: fake.downloader,
      settings,
    }),
  }).run(context);
  return { exitCode, stdout: output.join('\n'), logs: logs.join('\n'), requested: fake.requested };
}

const PDF_RESOURCE = ['--course-id', '12', '--resource-id', '501:file:/checklist.pdf'];

describe('extract:test', () => {
  it('downloads and extracts a resource, printing metadata, counts and a short preview', async () => {
    const result = await run(PDF_RESOURCE);
    expect(result.exitCode).toBe(0);
    expect(result.requested).toEqual([
      'https://ehub.example.test/webservice/pluginfile.php/5501/mod_resource/content/3/checklist.pdf?forcedownload=1',
    ]);
    expect(result.stdout).toContain('Extraction: EXTRACTED');
    expect(result.stdout).toContain('Course:    12 Consultation Standards');
    expect(result.stdout).toContain('Extractor: pdf 1.0.0');
    expect(result.stdout).toContain('3 pages');
    expect(result.stdout).toMatch(/SHA-256: {3}[0-9a-f]{64}/);
    expect(result.stdout).toContain('Preview (first');
  });

  it('caps the preview and never prints the whole document', async () => {
    const long = `<p>${'Confidential protocol sentence. '.repeat(200)}</p>`;
    const result = await run(['--course-id', '12', '--resource-id', '601:page', '--json'], {
      contents: 'contents-page',
      bytes: new TextEncoder().encode(long),
      contentType: 'text/html',
    });
    const parsed = JSON.parse(result.stdout) as {
      preview: { text: string; characters: number };
      statistics: { characters: number };
    };
    expect(parsed.preview.characters).toBeLessThanOrEqual(300);
    expect(parsed.statistics.characters).toBeGreaterThan(5000);
    expect(result.stdout.length).toBeLessThan(5000);
  });

  it('omits the preview with --no-preview', async () => {
    const result = await run([...PDF_RESOURCE, '--no-preview', '--json']);
    expect(JSON.parse(result.stdout)).not.toHaveProperty('preview');
  });

  it('outputs the diagnostic as JSON', async () => {
    const result = await run([...PDF_RESOURCE, '--json']);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'status',
      'resource',
      'extractor',
      'contentHash',
      'statistics',
      'warnings',
      'preview',
    ]);
    expect(parsed['resource']).toMatchObject({
      resourceType: 'pdf',
      mimeType: 'application/pdf',
      detectedContentType: 'pdf',
    });
  });

  it('logs counts only, never document text', async () => {
    const result = await run(PDF_RESOURCE);
    expect(result.logs).toContain('Extraction test completed.');
    expect(result.logs).not.toContain('medical history');
    expect(result.logs).not.toContain('Consultation checklist');
  });

  it('exits 1 with a structured result when extraction fails', async () => {
    const result = await run([...PDF_RESOURCE, '--json'], { bytes: loadBinary('encrypted.pdf') });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'failed', reason: 'encrypted' });
  });

  it('does not download a resource discovery already marked unsupported', async () => {
    const result = await run(
      ['--course-id', '12', '--resource-id', '801:file:/slides/price-list.xlsx', '--json'],
      {
        contents: 'contents-multiple-files',
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.requested).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'unsupported',
      reason: 'discovery:file_type_not_supported',
      warnings: ['not_downloaded'],
    });
  });

  it('reports an unknown resource ID without echoing it', async () => {
    const result = await run(['--course-id', '12', '--resource-id', '999:file:/secret-name.pdf']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('not_found / resource_not_found');
    expect(result.stdout).not.toContain('secret-name');
  });

  it.each([
    [['--course-id', '12'], '--resource-id: is required.'],
    [['--resource-id', '501:page'], '--course-id: is required.'],
    [['--course-id', '12', '--resource-id', 'checklist.pdf'], '--resource-id: must look like'],
  ])('rejects %j as a usage error', async (args, message) => {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(message);
  });

  it('reports invalid extraction configuration by variable name', async () => {
    const result = await run(PDF_RESOURCE, { env: { ...env, EXTRACTION_TIMEOUT_MS: 'soon' } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('EXTRACTION_TIMEOUT_MS: Must be a number.');
  });
});
