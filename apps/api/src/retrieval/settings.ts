import type { RetrievalConfig } from '@ehub/shared';

export interface RetrievalSettings {
  /** Chunks returned after the per-resource cap and thresholds. */
  readonly topK: number;
  /** At most this many chunks from one Moodle resource, so one long file cannot crowd out others. */
  readonly maxChunksPerResource: number;
  /** Results requested from the index before capping and thresholds. */
  readonly candidateCount: number;
  readonly semanticRanking: boolean;
  readonly minScore: number | undefined;
  readonly minRerankerScore: number | undefined;
}

export function retrievalSettingsFromConfig(config: RetrievalConfig): RetrievalSettings {
  return {
    topK: config.RETRIEVAL_TOP_K,
    maxChunksPerResource: config.RETRIEVAL_MAX_CHUNKS_PER_RESOURCE,
    candidateCount: config.RETRIEVAL_CANDIDATE_COUNT,
    semanticRanking: config.RETRIEVAL_SEMANTIC_RANKING,
    minScore: config.RETRIEVAL_MIN_SCORE,
    minRerankerScore: config.RETRIEVAL_MIN_RERANKER_SCORE,
  };
}
