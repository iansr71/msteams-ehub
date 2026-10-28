import { searchDocumentSchema, type SearchDocument } from '@ehub/shared/search';

import type { ContentChunk } from '../pipeline/chunkMetadata.js';

export class VectorDimensionError extends Error {
  constructor(actual: number, expected: number) {
    super(
      `Embedding has ${String(actual)} dimensions; the index expects ${String(expected)} (AZURE_SEARCH_VECTOR_DIMENSIONS).`,
    );
    this.name = 'VectorDimensionError';
  }
}

export class InvalidSearchDocumentError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Chunk cannot be stored in the search index (fields: ${fields.join(', ')}).`);
    this.name = 'InvalidSearchDocumentError';
    this.fields = fields;
  }
}

/**
 * Maps a validated chunk and its embedding to the stored index document. `overlapTokens` is a
 * chunking diagnostic and is not stored. Throws when the embedding size does not match the
 * index, because Azure would reject the whole batch.
 */
export function toSearchDocument(
  chunk: ContentChunk,
  vector: readonly number[],
  expectedDimensions: number,
): SearchDocument {
  if (vector.length !== expectedDimensions) {
    throw new VectorDimensionError(vector.length, expectedDimensions);
  }
  const fields: Partial<ContentChunk> = { ...chunk };
  delete fields.chunkId;
  delete fields.overlapTokens;
  const parsed = searchDocumentSchema.safeParse({
    id: chunk.chunkId,
    ...fields,
    contentVector: [...vector],
  });
  if (!parsed.success) {
    // Field paths only: Zod issues can quote the offending (document) values.
    throw new InvalidSearchDocumentError([
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  }
  return parsed.data;
}
