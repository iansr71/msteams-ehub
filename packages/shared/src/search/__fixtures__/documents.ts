import { createHash } from 'node:crypto';

import type { SearchDocument } from '../documents.js';

/**
 * Test-only placeholder for an embedding model: a deterministic unit vector derived from the
 * text. It has no semantic meaning; real embeddings arrive in phase 8.
 */
export function placeholderVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block += 1) {
    const digest = createHash('sha256')
      .update(`${String(block)}:${text}`)
      .digest();
    for (let offset = 0; offset + 1 < digest.length && values.length < dimensions; offset += 2) {
      values.push(digest.readUInt16BE(offset) / 65535 - 0.5);
    }
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export const TEST_DIMENSIONS = 8;

export function hexId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

export function makeSearchDocument(
  overrides: Partial<SearchDocument> & { readonly seed?: string } = {},
): SearchDocument {
  const { seed = 'doc-1', ...rest } = overrides;
  const content = rest.content ?? `Aftercare guidance ${seed}.`;
  return {
    id: hexId(seed),
    tenantId: 'tenant-1',
    courseId: 12,
    courseName: 'Consultation Skills',
    sectionId: 3,
    sectionName: 'Aftercare',
    moduleId: 701,
    moduleName: 'Aftercare handbook',
    moduleUrl: 'https://ehub.example.test/mod/book/view.php?id=701',
    resourceId: '701:chapter:11',
    resourceName: 'Aftercare',
    resourceType: 'moodle-book-chapter',
    fileName: 'index.html',
    title: 'Aftercare',
    headingPath: ['Aftercare handbook', 'Aftercare'],
    content,
    contentVector: placeholderVector(content, TEST_DIMENSIONS),
    chunkNumber: 1,
    chunkCount: 1,
    tokenCount: 12,
    contentHash: hexId(`content:${content}`),
    sourceContentHash: hexId(`source:${seed}`),
    indexedAt: '2026-10-28T08:00:00.000Z',
    extractorVersion: 'html@1.0.0',
    chunkerVersion: 'structure-aware@1.0.0',
    allowedUserIds: ['user-1'],
    allowedGroupIds: ['group-1'],
    isActive: true,
    ...rest,
  };
}
