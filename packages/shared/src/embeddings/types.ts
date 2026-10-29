/** Identifies how a vector was produced; stored with every indexed chunk. */
export interface EmbeddingMetadata {
  /** The model behind the deployment, e.g. `text-embedding-3-small`. */
  readonly modelIdentifier: string;
  /** Bumped to force re-embedding with the same model. */
  readonly embeddingVersion: string;
  readonly dimensions: number;
  /** ISO timestamp of when the vector was generated (not when it was read from a cache). */
  readonly generatedAt: string;
  /** SHA-256 (hex) of the normalised text that was embedded. */
  readonly contentHash: string;
  /** SHA-256 (hex) of model, version, dimensions and content hash. */
  readonly cacheKey: string;
}

export interface Embedding {
  readonly vector: readonly number[];
  readonly metadata: EmbeddingMetadata;
  /** True when the vector came from the cache instead of the model. */
  readonly cached: boolean;
}

export interface EmbedOptions {
  readonly signal?: AbortSignal;
}

export type EmbeddingHealthStatus = 'healthy' | 'unhealthy';

export interface EmbeddingHealthReport {
  readonly status: EmbeddingHealthStatus;
  readonly authMode: 'api-key' | 'entra-id';
  readonly deployment: string;
  readonly modelIdentifier: string;
  readonly embeddingVersion: string;
  readonly expectedDimensions: number;
  /** Length of the vector the service returned for the probe text. */
  readonly returnedDimensions?: number;
  readonly latencyMs: number;
  /** Sanitised descriptions of what is wrong; empty when healthy. */
  readonly problems: readonly string[];
  readonly failure?: { readonly category: string; readonly httpStatus?: number };
}

/**
 * Turns text into vectors. Implementations validate input, enforce model limits, verify the
 * returned dimensions and never log the text or the vectors.
 */
export interface EmbeddingProvider {
  embedText(text: string, options?: EmbedOptions): Promise<Embedding>;
  /** Results are in input order. */
  embedBatch(texts: readonly string[], options?: EmbedOptions): Promise<Embedding[]>;
  getDimensions(): number;
  getModelIdentifier(): string;
  getEmbeddingVersion(): string;
  healthCheck(options?: EmbedOptions): Promise<EmbeddingHealthReport>;
}
