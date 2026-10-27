import { createLogger } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import {
  input,
  loadBinary,
  minimalDocx,
  testLimits,
  testResource,
} from './__fixtures__/helpers.js';
import {
  DEFAULT_EXTRACTORS,
  ExtractorRegistry,
  extractionLimitsFromConfig,
} from './extractorRegistry.js';
import type { ContentExtractor, ExtractionResult } from './types.js';

function registry(
  options: {
    extractors?: readonly ContentExtractor[];
    limits?: Parameters<typeof testLimits>[0];
  } = {},
) {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    sink: { write: (line) => lines.push(line) },
  });
  return {
    registry: new ExtractorRegistry({
      limits: testLimits(options.limits),
      logger,
      ...(options.extractors === undefined ? {} : { extractors: options.extractors }),
    }),
    logs: lines,
  };
}

function expectStatus<S extends ExtractionResult['status']>(
  result: ExtractionResult,
  status: S,
): Extract<ExtractionResult, { status: S }> {
  expect(result.status).toBe(status);
  return result as Extract<ExtractionResult, { status: S }>;
}

describe('ExtractorRegistry', () => {
  it('returns the normalised result with full metadata, hash and extractor version', async () => {
    const { registry: subject } = registry();
    const result = expectStatus(
      await subject.extract(
        testResource('primary', { fileName: 'checklist.pdf', mimeType: 'application/pdf' }),
        input(loadBinary('sample.pdf')),
      ),
      'extracted',
    );
    expect(result).toMatchObject({
      courseId: 12,
      courseName: 'Consultation Standards',
      sectionId: 101,
      sectionName: 'General',
      moduleId: 501,
      moduleName: 'Consultation checklist',
      resourceId: '501:file:/document',
      resourceName: 'document',
      resourceType: 'pdf',
      fileName: 'checklist.pdf',
      mimeType: 'application/pdf',
      declaredMimeType: 'application/pdf',
      detectedContentType: 'pdf',
      sourceUrl:
        'https://ehub.example.test/webservice/pluginfile.php/5501/mod_resource/content/3/document',
      moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=501',
      modifiedAt: '2025-06-15T15:15:00.000Z',
      warnings: [],
      extractor: { name: 'pdf', version: '1.0.0' },
    });
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.characterCount).toBe(
      result.blocks.reduce((sum, block) => sum + block.text.length, 0),
    );
    expect(result.blocks[0]?.pageNumber).toBe(1);
  });

  it('routes by detected type and role', async () => {
    const { registry: subject } = registry();
    const html = '<h1>T</h1><p>Body</p>';
    expect((await subject.extract(testResource('page-body'), input(html))).resourceType).toBe(
      'moodle-page',
    );
    expect((await subject.extract(testResource('book-chapter'), input(html))).resourceType).toBe(
      'moodle-book-chapter',
    );
    expect((await subject.extract(testResource('folder-file'), input(html))).resourceType).toBe(
      'html',
    );
    expect((await subject.extract(testResource('primary'), input('notes'))).resourceType).toBe(
      'plain-text',
    );
    expect(
      (await subject.extract(testResource(), input(loadBinary('sample.docx')))).resourceType,
    ).toBe('docx');
    expect(
      (await subject.extract(testResource(), input(loadBinary('sample.pptx')))).resourceType,
    ).toBe('pptx');
  });

  it('trusts the bytes over the declared type, with a warning', async () => {
    const { registry: subject } = registry();
    const result = expectStatus(
      await subject.extract(
        testResource('primary', { fileName: 'report.pdf', mimeType: 'application/pdf' }),
        input('<p>Actually HTML</p>'),
      ),
      'extracted',
    );
    expect(result).toMatchObject({
      detectedContentType: 'html',
      mimeType: 'text/html',
      resourceType: 'html',
    });
    expect(result.warnings).toContain('declared_type_mismatch');
  });

  it.each([
    ['encrypted PDF', () => loadBinary('encrypted.pdf'), 'failed', 'encrypted'],
    ['encrypted Word document', () => loadBinary('encrypted.docx'), 'failed', 'encrypted'],
    ['corrupt PDF', () => loadBinary('sample.pdf').slice(0, 900), 'failed', 'corrupt'],
    ['empty file', () => new Uint8Array(), 'failed', 'empty'],
    ['scanned PDF without text', () => loadBinary('blank.pdf'), 'failed', 'empty'],
    ['empty Word document', () => loadBinary('empty.docx'), 'failed', 'empty'],
    [
      'executable',
      () => new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]),
      'unsupported',
      'unsupported_content_type',
    ],
    [
      'legacy .doc',
      () => {
        const b = new Uint8Array(512);
        b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        return b;
      },
      'unsupported',
      'legacy_office_format',
    ],
    [
      'macro document',
      () => minimalDocx('<w:p/>', [{ name: 'word/vbaProject.bin', data: 'x' }]),
      'unsupported',
      'macro_enabled_document',
    ],
  ] as const)('returns a structured result for an %s', async (_label, bytes, status, reason) => {
    const { registry: subject } = registry();
    const result = await subject.extract(testResource(), input(bytes()));
    expect(result).toMatchObject({ status, reason });
    expect(result).not.toHaveProperty('blocks');
  });

  it('refuses input larger than the limit without parsing it', async () => {
    const { registry: subject } = registry({ limits: { maxInputBytes: 1024 } });
    const result = await subject.extract(testResource(), input(loadBinary('sample.pdf')));
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'input_too_large',
      detectedContentType: 'empty',
    });
  });

  it('turns an extractor exception into extractor_error without exposing its message', async () => {
    const secretText = 'CONFIDENTIAL PATIENT NOTE quoted by a parser error';
    const throwing: ContentExtractor = {
      name: 'boom',
      version: '9.9.9',
      resourceType: 'plain-text',
      supports: () => true,
      extract: () => Promise.reject(new Error(secretText)),
    };
    const { registry: subject, logs } = registry({ extractors: [throwing] });
    const result = await subject.extract(testResource(), input('text'));
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'extractor_error',
      extractor: { name: 'boom', version: '9.9.9' },
    });
    expect(JSON.stringify(result)).not.toContain(secretText);
    expect(logs.join('\n')).not.toContain(secretText);
  });

  it('times out an extractor that never finishes', async () => {
    const hanging: ContentExtractor = {
      name: 'hang',
      version: '1.0.0',
      resourceType: 'plain-text',
      supports: () => true,
      extract: (_candidate, _input, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    };
    const { registry: subject } = registry({ extractors: [hanging], limits: { timeoutMs: 30 } });
    expect(await subject.extract(testResource(), input('text'))).toMatchObject({
      status: 'failed',
      reason: 'timeout',
    });
  });

  it('reports content with no matching extractor', async () => {
    const { registry: subject } = registry({ extractors: [] });
    expect(await subject.extract(testResource(), input('text'))).toMatchObject({
      status: 'unsupported',
      reason: 'no_extractor',
    });
  });

  it('falls back to Last-Modified when Moodle has no timestamp', async () => {
    const { registry: subject } = registry();
    const result = await subject.extract(testResource('primary', { timeModified: undefined }), {
      bytes: new TextEncoder().encode('text'),
      declaredContentType: 'text/plain',
      lastModified: 'Wed, 01 Oct 2025 10:00:00 GMT',
    });
    expect(result.modifiedAt).toBe('2025-10-01T10:00:00.000Z');
  });

  it('logs metadata only, never document text', async () => {
    const { registry: subject, logs } = registry();
    await subject.extract(testResource(), input('<p>Private aftercare instructions</p>'));
    const output = logs.join('\n');
    expect(output).toContain('Extraction completed.');
    expect(output).not.toContain('Private aftercare');
  });

  it('gives the same hash for the same content', async () => {
    const { registry: subject } = registry();
    const first = expectStatus(
      await subject.extract(testResource(), input(loadBinary('sample.docx'))),
      'extracted',
    );
    const second = expectStatus(
      await subject.extract(testResource(), input(loadBinary('sample.docx'))),
      'extracted',
    );
    expect(second.contentHash).toBe(first.contentHash);
  });
});

describe('extractionLimitsFromConfig', () => {
  it('maps configuration and caps the per-entry limit by the total', () => {
    const limits = extractionLimitsFromConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      PORT: 3000,
      EXTRACTION_MAX_INPUT_BYTES: 1_000_000,
      EXTRACTION_MAX_TEXT_CHARS: 5_000,
      EXTRACTION_TIMEOUT_MS: 10_000,
      EXTRACTION_MAX_ARCHIVE_ENTRIES: 100,
      EXTRACTION_MAX_UNCOMPRESSED_BYTES: 2 * 1024 * 1024,
    });
    expect(limits).toEqual({
      maxInputBytes: 1_000_000,
      maxTextChars: 5_000,
      timeoutMs: 10_000,
      maxArchiveEntries: 100,
      maxUncompressedBytes: 2 * 1024 * 1024,
      maxEntryBytes: 2 * 1024 * 1024,
      maxCompressionRatio: 200,
      maxXmlDepth: 256,
    });
  });

  it('registers every extractor named in the specification', () => {
    expect(DEFAULT_EXTRACTORS.map((extractor) => extractor.name).sort()).toEqual(
      ['docx', 'html', 'moodle-book', 'moodle-page', 'pdf', 'plain-text', 'pptx'].sort(),
    );
  });
});
