import type { Embedding } from '@ehub/shared/embeddings';
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
 * The text embedded for a chunk: its location (resource and heading path) followed by the
 * content. The location helps short chunks such as a list under a heading match questions
 * about that heading; it is part of the hashed input, so a renamed heading re-embeds the chunk.
 */
export function buildEmbeddingText(chunk: ContentChunk): string {
  const location: string[] = [];
  for (const part of [chunk.resourceName, ...chunk.headingPath]) {
    if (part.trim() !== '' && location.at(-1) !== part) {
      location.push(part);
    }
  }
  return location.length === 0 ? chunk.content : `${location.join(' > ')}\n\n${chunk.content}`;
}

/**
 * Maps a validated chunk and its embedding to the stored index document, recording how the
 * vector was made. `overlapTokens` is a chunking diagnostic and is not stored. Throws when the
 * embedding size does not match the index, because Azure would reject the whole batch.
 */
export function toSearchDocument(
  chunk: ContentChunk,
  embedding: Pick<Embedding, 'vector' | 'metadata'>,
  expectedDimensions: number,
): SearchDocument {
  const { vector, metadata } = embedding;
  if (vector.length !== expectedDimensions || metadata.dimensions !== expectedDimensions) {
    throw new VectorDimensionError(vector.length, expectedDimensions);
  }
  const fields: Partial<ContentChunk> = { ...chunk };
  delete fields.chunkId;
  delete fields.overlapTokens;
  const parsed = searchDocumentSchema.safeParse({
    id: chunk.chunkId,
    ...fields,
    contentVector: [...vector],
    embeddingModel: metadata.modelIdentifier,
    embeddingVersion: metadata.embeddingVersion,
    embeddingDimensions: metadata.dimensions,
    embeddedAt: metadata.generatedAt,
  });
  if (!parsed.success) {
    // Field paths only: Zod issues can quote the offending (document) values.
    throw new InvalidSearchDocumentError([
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  }
  return parsed.data;
}
