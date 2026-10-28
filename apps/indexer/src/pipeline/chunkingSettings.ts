import type { ChunkingConfig } from '@ehub/shared';

import type { ChunkingOptions } from './chunkContent.js';
import { createTiktokenCounter, type TokenCounter } from './tokenCounter.js';

export interface ChunkingSettings {
  readonly options: ChunkingOptions;
  readonly counter: TokenCounter;
}

/** Maps validated CHUNK_* configuration (cross-field rules already enforced) to the chunker. */
export function chunkingSettingsFromConfig(config: ChunkingConfig): ChunkingSettings {
  return {
    options: {
      targetTokens: config.CHUNK_TARGET_TOKENS,
      maxTokens: config.CHUNK_MAX_TOKENS,
      minTokens: config.CHUNK_MIN_TOKENS,
      overlapTokens: config.CHUNK_OVERLAP_TOKENS,
    },
    counter: createTiktokenCounter(config.CHUNK_TOKENIZER),
  };
}
