import { describe, expect, it } from 'vitest';

import { placeholderVector } from '../../../../packages/shared/src/search/__fixtures__/documents.js';
import {
  CHUNKER_VERSION,
  buildChunkId,
  contentChunkSchema,
  hashChunkContent,
  type ContentChunk,
} from '../pipeline/chunkMetadata.js';
import { searchDiagnosticsFixture } from './__fixtures__/reports.js';
import {
  renderCreateIndexText,
  renderHealthText,
  renderValidationText,
  summarizeIndexingReport,
} from './searchDiagnostics.js';
import {
  InvalidSearchDocumentError,
  VectorDimensionError,
  toSearchDocument,
} from './searchDocuments.js';

const content = 'Apply SPF 50 every two hours after a peel.';

function chunk(overrides: Partial<ContentChunk> = {}): ContentChunk {
  return contentChunkSchema.parse({
    chunkId: buildChunkId('tenant-1', 12, '702:file:/Aftercare.pdf', 2),
    tenantId: 'tenant-1',
    courseId: 12,
    courseName: 'Consultation Skills',
    courseCategory: '4',
    sectionId: 3,
    sectionName: 'Aftercare',
    moduleId: 702,
    moduleName: 'Aftercare leaflets',
    resourceId: '702:file:/Aftercare.pdf',
    resourceName: 'Aftercare.pdf',
    resourceType: 'pdf',
    fileName: 'Aftercare.pdf',
    mimeType: 'application/pdf',
    title: 'Sun protection',
    headingPath: ['Aftercare', 'Sun protection'],
    content,
    pageNumber: 3,
    pageNumberEnd: 4,
    chunkNumber: 2,
    chunkCount: 5,
    tokenCount: 14,
    overlapTokens: 3,
    sourceUrl:
      'https://ehub.example.test/webservice/pluginfile.php/1/mod_resource/content/1/Aftercare.pdf',
    moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=702',
    contentHash: hashChunkContent(content),
    sourceContentHash: hashChunkContent('whole file'),
    modifiedAt: '2026-09-01T10:00:00.000Z',
    indexedAt: '2026-10-28T08:00:00.000Z',
    extractorVersion: 'pdf@1.0.0',
    chunkerVersion: CHUNKER_VERSION,
    allowedUserIds: ['user-1'],
    allowedGroupIds: [],
    isActive: true,
    ...overrides,
  });
}

describe('toSearchDocument', () => {
  it('maps every chunk field and the vector, preserving citation metadata', () => {
    const source = chunk();
    const vector = placeholderVector(content, 8);
    const document = toSearchDocument(source, vector, 8);
    expect(document.id).toBe(source.chunkId);
    expect(document).toMatchObject({
      courseId: 12,
      sectionName: 'Aftercare',
      resourceId: '702:file:/Aftercare.pdf',
      pageNumber: 3,
      pageNumberEnd: 4,
      sourceUrl: source.sourceUrl,
      moduleUrl: source.moduleUrl,
      headingPath: ['Aftercare', 'Sun protection'],
      contentVector: vector,
    });
    expect(document).not.toHaveProperty('chunkId');
    expect(document).not.toHaveProperty('overlapTokens');
  });

  it('rejects an embedding of the wrong size', () => {
    expect(() => toSearchDocument(chunk(), placeholderVector(content, 7), 8)).toThrow(
      VectorDimensionError,
    );
  });

  it('reports invalid chunks by field name without quoting values', () => {
    const invalid = { ...chunk(), modifiedAt: 'Confidential: 1 Sept' };
    const failure = (() => {
      try {
        toSearchDocument(invalid, placeholderVector(content, 8), 8);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(InvalidSearchDocumentError);
    expect((failure as InvalidSearchDocumentError).fields).toEqual(['modifiedAt']);
    expect((failure as Error).message).not.toContain('Confidential');
  });
});

describe('search diagnostics rendering', () => {
  it('renders validation, creation and health without control characters', () => {
    const { validation, health, indexing } = searchDiagnosticsFixture;
    const validationText = renderValidationText(validation);
    expect(validationText).toContain('INCOMPATIBLE (migration to a new index required)');
    expect(validationText.indexOf('[INCOMPATIBLE]')).toBeLessThan(
      validationText.indexOf('[compatible]'),
    );
    expect(validationText).not.toContain('\u001b');
    expect(
      renderCreateIndexText('ehub-course-content-v1', {
        outcome: 'migration-required',
        validation,
      }),
    ).toContain('ehub-course-content-v2');
    const healthText = renderHealthText(health);
    expect(healthText).toContain('Authentication: Microsoft Entra ID');
    expect(healthText).toContain('documentCount: 10 of 1000000');
    expect(summarizeIndexingReport(indexing)).toEqual({
      action: 'upload',
      attempted: 3,
      succeeded: 1,
      failed: 2,
      failureReasons: { rejected: 1, 'retries-exhausted': 1 },
      requests: 2,
      retriedDocuments: 1,
      durationMs: 5,
    });
  });
});
