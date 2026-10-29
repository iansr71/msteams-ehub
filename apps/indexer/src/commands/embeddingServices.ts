import {
  azureSearchConfigSchema,
  embeddingConfigSchema,
  getConfigFeatureStatus,
  loadConfig,
  type EnvironmentSource,
  type Logger,
} from '@ehub/shared';
import {
  EmbeddingError,
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingSettings,
} from '@ehub/shared/embeddings';
import {
  createSearchIndexClient,
  type SearchClientSettings,
  type SearchIndexClient,
} from '@ehub/shared/search';

import { createTiktokenCounter } from '../pipeline/tokenCounter.js';

/** Injection points: tests supply fake providers and search clients. */
export interface EmbeddingCommandDependencies {
  readonly env: EnvironmentSource;
  readonly createEmbedder?: (
    settings: EmbeddingSettings,
    logger: Logger,
  ) => Promise<EmbeddingProvider>;
  readonly createSearch?: (
    settings: SearchClientSettings,
    logger: Logger,
  ) => Promise<Pick<SearchIndexClient, 'getDeployedVectorDimensions'>>;
}

// text-embedding-3 and ada-002 use the cl100k_base encoding, so input limits are counted exactly.
const embeddingTokenCounter = createTiktokenCounter('cl100k_base');

export async function openEmbeddingProvider(
  dependencies: EmbeddingCommandDependencies,
  logger: Logger,
): Promise<{ provider: EmbeddingProvider; settings: EmbeddingSettings }> {
  const settings = loadConfig(embeddingConfigSchema, dependencies.env);
  const create =
    dependencies.createEmbedder ??
    ((resolved: EmbeddingSettings, log: Logger) =>
      createEmbeddingProvider(resolved, {
        logger: log,
        countTokens: (text) => embeddingTokenCounter.count(text),
      }));
  return { provider: await create(settings, logger), settings };
}

export interface DimensionAlignment {
  readonly embeddingDimensions: number;
  /** AZURE_SEARCH_VECTOR_DIMENSIONS, when search is configured. */
  readonly configuredIndexDimensions?: number;
  /** The deployed index's vector field, when it could be read. */
  readonly deployedIndexDimensions?: number;
  readonly aligned: boolean;
  readonly problems: readonly string[];
}

/**
 * Compares the embedding size with the search configuration and the deployed index. Search
 * being unconfigured or unreachable is reported, not fatal: embeddings can be checked alone.
 */
export async function checkDimensionAlignment(
  dependencies: EmbeddingCommandDependencies,
  embeddingDimensions: number,
  logger: Logger,
): Promise<DimensionAlignment> {
  const problems: string[] = [];
  if (getConfigFeatureStatus('azureSearch', dependencies.env).state !== 'valid') {
    return {
      embeddingDimensions,
      aligned: true,
      problems: ['Azure AI Search is not configured; the index dimensions were not checked.'],
    };
  }
  const searchSettings = loadConfig(azureSearchConfigSchema, dependencies.env);
  const configured = searchSettings.AZURE_SEARCH_VECTOR_DIMENSIONS;
  let aligned = true;
  if (configured !== embeddingDimensions) {
    aligned = false;
    problems.push(
      `AZURE_OPENAI_EMBEDDING_DIMENSIONS (${String(embeddingDimensions)}) does not match AZURE_SEARCH_VECTOR_DIMENSIONS (${String(configured)}).`,
    );
  }
  let deployed: number | undefined;
  try {
    const create =
      dependencies.createSearch ??
      ((resolved: SearchClientSettings, log: Logger) =>
        createSearchIndexClient(resolved, { logger: log }));
    deployed = await (await create(searchSettings, logger)).getDeployedVectorDimensions();
    if (deployed === undefined) {
      problems.push(
        `Index ${searchSettings.AZURE_SEARCH_INDEX_NAME} does not exist yet; run search:create-index.`,
      );
    } else if (deployed !== embeddingDimensions) {
      aligned = false;
      problems.push(
        `The deployed index stores ${String(deployed)}-dimension vectors; the embedding model produces ${String(embeddingDimensions)}. A new index is needed (see docs/search-index.md).`,
      );
    }
  } catch (error) {
    problems.push(
      `The deployed index could not be read: ${error instanceof Error ? error.message : 'unexpected error'}`,
    );
  }
  return {
    embeddingDimensions,
    configuredIndexDimensions: configured,
    ...(deployed === undefined ? {} : { deployedIndexDimensions: deployed }),
    aligned,
    problems,
  };
}

export function assertAligned(alignment: DimensionAlignment): void {
  if (!alignment.aligned) {
    throw new EmbeddingError(alignment.problems.join(' '), { category: 'dimension_mismatch' });
  }
}
