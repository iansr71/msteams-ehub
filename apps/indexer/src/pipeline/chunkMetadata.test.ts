import { describe, expect, it } from 'vitest';

import { document, TEST_CONTEXT } from './__fixtures__/documents.js';
import {
  buildChunkId,
  buildContentChunk,
  contentChunkSchema,
  hashChunkContent,
} from './chunkMetadata.js';
import { normalizeContent } from './normalizeContent.js';

const placement = {
  content: 'Body text.',
  tokenCount: 3,
  overlapTokens: 0,
  headingPath: ['Guide', 'Steps'],
  pageNumber: 2,
  pageNumberEnd: 3,
  slideNumber: undefined,
};

describe('buildChunkId', () => {
  it('is a deterministic 64-character hex key', () => {
    const id = buildChunkId('tenant', 12, '501:file:/a.pdf', 1);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(buildChunkId('tenant', 12, '501:file:/a.pdf', 1)).toBe(id);
  });

  it('differs by tenant, course, resource and position, with no concatenation ambiguity', () => {
    const base = buildChunkId('t', 12, 'r', 1);
    expect(buildChunkId('t2', 12, 'r', 1)).not.toBe(base);
    expect(buildChunkId('t', 13, 'r', 1)).not.toBe(base);
    expect(buildChunkId('t', 12, 'r2', 1)).not.toBe(base);
    expect(buildChunkId('t', 12, 'r', 2)).not.toBe(base);
    expect(buildChunkId('t', 1, '2r', 1)).not.toBe(buildChunkId('t', 12, 'r', 1));
  });
});

describe('buildContentChunk', () => {
  const normalized = normalizeContent(document([]));

  it('builds a schema-valid chunk with title, page range and hashes', () => {
    const chunk = buildContentChunk(normalized, placement, 2, 5, TEST_CONTEXT);
    expect(contentChunkSchema.safeParse(chunk).success).toBe(true);
    expect(chunk).toMatchObject({
      title: 'Steps',
      headingPath: ['Guide', 'Steps'],
      pageNumber: 2,
      pageNumberEnd: 3,
      chunkNumber: 2,
      chunkCount: 5,
      contentHash: hashChunkContent('Body text.'),
    });
    expect(chunk).not.toHaveProperty('slideNumber');
  });

  it('falls back to the resource name when there is no heading, and omits a single-page end', () => {
    const chunk = buildContentChunk(
      normalized,
      { ...placement, headingPath: [], pageNumberEnd: 2 },
      1,
      1,
      TEST_CONTEXT,
    );
    expect(chunk.title).toBe('aftercare.docx');
    expect(chunk).not.toHaveProperty('pageNumberEnd');
  });

  it('rejects an invalid tenant or access identifier', () => {
    expect(() =>
      buildContentChunk(normalized, placement, 1, 1, { ...TEST_CONTEXT, tenantId: 'bad tenant!' }),
    ).toThrow();
    expect(() =>
      buildContentChunk(normalized, placement, 1, 1, {
        ...TEST_CONTEXT,
        access: { allowedUserIds: ['<script>'], allowedGroupIds: [] },
      }),
    ).toThrow();
  });

  it('allows empty access lists, which retrieval must treat as "nobody" (fail closed)', () => {
    const chunk = buildContentChunk(normalized, placement, 1, 1, {
      ...TEST_CONTEXT,
      access: { allowedUserIds: [], allowedGroupIds: [] },
    });
    expect(chunk.allowedUserIds).toEqual([]);
    expect(chunk.allowedGroupIds).toEqual([]);
  });

  it('refuses a document without an extracted resource type', () => {
    const untyped = {
      ...normalized,
      metadata: { ...normalized.metadata, resourceType: undefined },
    };
    expect(() => buildContentChunk(untyped, placement, 1, 1, TEST_CONTEXT)).toThrow();
  });
});
