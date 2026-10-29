import type { EmbedOptions, EmbeddingProvider } from '@ehub/shared/embeddings';
import type { SearchDocument } from '@ehub/shared/search';

import type { ContentChunk } from '../pipeline/chunkMetadata.js';
import { VectorDimensionError, buildEmbeddingText, toSearchDocument } from './searchDocuments.js';

export interface EmbeddedChunks {
  /** Index documents, in chunk order. */
  readonly documents: readonly SearchDocument[];
  /** Embeddings requested from the model. */
  readonly generated: number;
  /** Embeddings served from the cache (unchanged text, same model and version). */
  readonly cached: number;
}

/**
 * Embeds a resource's chunks and builds their index documents. The provider's cache means
 * unchanged chunks are not re-embedded while the model and embedding version stay the same.
 */
export async function embedChunks(
  chunks: readonly ContentChunk[],
  provider: EmbeddingProvider,
  indexDimensions: number,
  options: EmbedOptions = {},
): Promise<EmbeddedChunks> {
  if (provider.getDimensions() !== indexDimensions) {
    throw new VectorDimensionError(provider.getDimensions(), indexDimensions);
  }
  if (chunks.length === 0) {
    return { documents: [], generated: 0, cached: 0 };
  }
  const embeddings = await provider.embedBatch(chunks.map(buildEmbeddingText), options);
  const documents = chunks.map((chunk, index) => {
    const embedding = embeddings[index];
    if (embedding === undefined) {
      throw new Error('The embedding provider returned fewer embeddings than chunks.');
    }
    return toSearchDocument(chunk, embedding, indexDimensions);
  });
  const cached = embeddings.filter((embedding) => embedding.cached).length;
  return { documents, generated: embeddings.length - cached, cached };
}
