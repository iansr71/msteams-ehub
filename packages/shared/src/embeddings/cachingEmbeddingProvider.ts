import { createLogger, type Logger } from '../logging/logger.js';
import type { EmbeddingCache } from './cache.js';
import { EmbeddingError } from './errors.js';
import { embeddingCacheKey, hashEmbeddingInput, normalizeEmbeddingInput } from './input.js';
import type { EmbedOptions, Embedding, EmbeddingHealthReport, EmbeddingProvider } from './types.js';

export interface EmbeddingCacheStats {
  readonly hits: number;
  readonly misses: number;
}

const silentLogger = createLogger({ service: 'embeddings', level: 'silent' });

/**
 * Serves vectors for unchanged text from the cache and asks the inner provider only for the
 * rest. The key covers model, version, dimensions and the normalised text's hash, so a model or
 * version change always regenerates.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  readonly #inner: EmbeddingProvider;
  readonly #cache: EmbeddingCache;
  readonly #logger: Logger;
  #hits = 0;
  #misses = 0;

  constructor(inner: EmbeddingProvider, cache: EmbeddingCache, logger: Logger = silentLogger) {
    this.#inner = inner;
    this.#cache = cache;
    this.#logger = logger.child({ component: 'embedding-cache' });
  }

  get stats(): EmbeddingCacheStats {
    return { hits: this.#hits, misses: this.#misses };
  }

  getDimensions(): number {
    return this.#inner.getDimensions();
  }

  getModelIdentifier(): string {
    return this.#inner.getModelIdentifier();
  }

  getEmbeddingVersion(): string {
    return this.#inner.getEmbeddingVersion();
  }

  healthCheck(options?: EmbedOptions): Promise<EmbeddingHealthReport> {
    return this.#inner.healthCheck(options);
  }

  async embedText(text: string, options: EmbedOptions = {}): Promise<Embedding> {
    const [embedding] = await this.embedBatch([text], options);
    if (embedding === undefined) {
      throw new EmbeddingError('No embedding was returned.', { category: 'invalid_response' });
    }
    return embedding;
  }

  async embedBatch(texts: readonly string[], options: EmbedOptions = {}): Promise<Embedding[]> {
    const keys = texts.map((text) =>
      embeddingCacheKey({
        modelIdentifier: this.getModelIdentifier(),
        embeddingVersion: this.getEmbeddingVersion(),
        dimensions: this.getDimensions(),
        contentHash: hashEmbeddingInput(normalizeEmbeddingInput(text)),
      }),
    );
    let cached: ReadonlyMap<string, { vector: readonly number[]; metadata: Embedding['metadata'] }>;
    try {
      cached = await this.#cache.getMany(keys);
    } catch {
      // A broken cache only costs a regeneration.
      this.#logger.warn('Embedding cache read failed; regenerating.', { inputs: texts.length });
      cached = new Map();
    }
    const missingIndexes = keys.flatMap((key, index) => {
      const entry = cached.get(key);
      return entry?.vector.length === this.getDimensions() ? [] : [index];
    });
    const generated =
      missingIndexes.length === 0
        ? []
        : await this.#inner.embedBatch(
            missingIndexes.map((index) => texts[index] ?? ''),
            options,
          );
    if (generated.length > 0) {
      try {
        await this.#cache.setMany(generated);
      } catch {
        this.#logger.warn('Embedding cache write failed.', { entries: generated.length });
      }
    }
    const generatedByIndex = new Map(
      missingIndexes.map((index, position) => [index, generated[position]]),
    );
    const result = keys.map((key, index): Embedding => {
      const fresh = generatedByIndex.get(index);
      if (fresh !== undefined) {
        return fresh;
      }
      const entry = cached.get(key);
      if (entry === undefined) {
        throw new EmbeddingError('An embedding is missing.', { category: 'invalid_response' });
      }
      return { vector: entry.vector, metadata: entry.metadata, cached: true };
    });
    this.#hits += texts.length - missingIndexes.length;
    this.#misses += missingIndexes.length;
    this.#logger.debug('Embedding cache lookup.', {
      inputs: texts.length,
      hits: texts.length - missingIndexes.length,
      misses: missingIndexes.length,
    });
    return result;
  }
}
