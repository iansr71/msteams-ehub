import { resolve } from 'node:path';

import {
  azureSearchConfigSchema,
  chunkingConfigSchema,
  extractionConfigSchema,
  loadConfig,
  syncConfigSchema,
  type Logger,
} from '@ehub/shared';
import {
  createSearchIndexClient,
  type SearchClientSettings,
  type SearchIndexClient,
} from '@ehub/shared/search';

import { ExtractorRegistry, extractionLimitsFromConfig } from '../extractors/extractorRegistry.js';
import { buildPipelineVersions, chunkerVersionLabel } from '../jobs/fingerprints.js';
import type { SyncServices } from '../jobs/syncContext.js';
import { StructuredChunker } from '../pipeline/chunkContent.js';
import { chunkingSettingsFromConfig } from '../pipeline/chunkingSettings.js';
import { FileSyncStateRepository } from '../state/fileSyncStateRepository.js';
import { systemClock, type Clock, type SyncStateRepository } from '../state/syncStateRepository.js';
import { openEmbeddingProvider, type EmbeddingCommandDependencies } from './embeddingServices.js';
import { openMoodleAccess, type MoodleCommandDependencies } from './moodleServices.js';

/** Injection points for the sync commands; production builds real services from env. */
export interface SyncCommandDependencies extends MoodleCommandDependencies {
  readonly createEmbedder?: EmbeddingCommandDependencies['createEmbedder'];
  readonly createSearch?: (
    settings: SearchClientSettings,
    logger: Logger,
  ) => Promise<SearchIndexClient>;
  readonly createStateRepository?: (directory: string, clock: Clock) => SyncStateRepository;
  readonly clock?: Clock;
  /** Directory relative SYNC_STATE_DIR values resolve against (default: where pnpm was run). */
  readonly cwd?: string;
}

/** Setup problems found before any job starts (nothing has been changed). */
export class SyncSetupError extends Error {
  constructor(
    readonly code: 'index_missing' | 'index_incompatible' | 'dimension_mismatch',
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'SyncSetupError';
  }
}

/**
 * Builds every service a sync job needs and checks, before anything is written, that the index
 * exists with a compatible schema and the embedding size matches it.
 */
export async function openSyncServices(
  dependencies: SyncCommandDependencies,
  logger: Logger,
): Promise<SyncServices> {
  const { env } = dependencies;
  const sync = loadConfig(syncConfigSchema, env);
  const extraction = loadConfig(extractionConfigSchema, env);
  const chunkingConfig = loadConfig(chunkingConfigSchema, env);
  const searchSettings = loadConfig(azureSearchConfigSchema, env);

  const access = openMoodleAccess(dependencies, logger);
  const limits = extractionLimitsFromConfig(extraction);
  const { provider: embedder } = await openEmbeddingProvider(
    {
      env,
      ...(dependencies.createEmbedder === undefined
        ? {}
        : { createEmbedder: dependencies.createEmbedder }),
    },
    logger,
  );
  const search = await (
    dependencies.createSearch ??
    ((settings: SearchClientSettings, log: Logger) =>
      createSearchIndexClient(settings, { logger: log }))
  )(searchSettings, logger);

  const validation = await search.validateIndexSchema();
  if (validation.status === 'missing') {
    throw new SyncSetupError(
      'index_missing',
      `Index ${search.indexName} does not exist.`,
      'Run pnpm indexer search:create-index first.',
    );
  }
  if (validation.status === 'incompatible') {
    throw new SyncSetupError(
      'index_incompatible',
      `Index ${search.indexName} has an incompatible schema.`,
      'Run pnpm indexer search:validate-index and see docs/search-index.md.',
    );
  }
  const deployed = await search.getDeployedVectorDimensions();
  if (deployed !== embedder.getDimensions()) {
    throw new SyncSetupError(
      'dimension_mismatch',
      `The index stores ${String(deployed ?? 0)}-dimension vectors; the embedding model produces ${String(embedder.getDimensions())}.`,
      'Align AZURE_OPENAI_EMBEDDING_DIMENSIONS and AZURE_SEARCH_VECTOR_DIMENSIONS (see docs/embeddings.md).',
    );
  }

  const clock = dependencies.clock ?? systemClock;
  const directory = resolve(
    dependencies.cwd ?? env['INIT_CWD'] ?? process.cwd(),
    sync.SYNC_STATE_DIR,
  );
  const state = (
    dependencies.createStateRepository ??
    ((dir: string, stateClock: Clock) =>
      new FileSyncStateRepository({ directory: dir, clock: stateClock }))
  )(directory, clock);

  const chunking = chunkingSettingsFromConfig(chunkingConfig);
  const extractors = new ExtractorRegistry({ limits, logger });
  return {
    moodle: { client: access.client, baseUrl: access.baseUrl, downloader: access.downloader },
    extractors,
    chunker: new StructuredChunker(chunking.options, chunking.counter),
    embedder,
    search,
    state,
    versions: buildPipelineVersions({
      extractors: extractors.extractorVersions(),
      chunker: chunkerVersionLabel(chunking.options, chunking.counter.encoding),
      embeddingModel: embedder.getModelIdentifier(),
      embeddingVersion: embedder.getEmbeddingVersion(),
      embeddingDimensions: embedder.getDimensions(),
    }),
    settings: {
      tenantId: sync.AZURE_TENANT_ID,
      courseIds: sync.SYNC_ALL_COURSES ? undefined : (sync.SYNC_COURSE_IDS ?? []),
      allCourses: sync.SYNC_ALL_COURSES,
      includeHidden: sync.SYNC_INCLUDE_HIDDEN,
      maxAttempts: sync.SYNC_MAX_ATTEMPTS,
      retryBaseDelayMs: sync.SYNC_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: sync.SYNC_RETRY_MAX_DELAY_MS,
      leaseTtlMs: sync.SYNC_LEASE_TTL_MS,
      maxDeleteFraction: sync.SYNC_MAX_DELETE_FRACTION,
      maxDeleteMinimum: sync.SYNC_MAX_DELETE_MINIMUM,
      maxDownloadBytes: Math.min(access.settings.maxDownloadBytes, limits.maxInputBytes),
    },
    clock,
    logger,
  };
}
