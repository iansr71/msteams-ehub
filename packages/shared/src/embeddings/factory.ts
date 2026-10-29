import type { EmbeddingConfig } from '../config/schema.js';
import type { HttpFetch } from '../http/retry.js';
import type { Logger } from '../logging/logger.js';
import {
  apiKeyAuthenticator,
  createDefaultSearchCredential,
  tokenCredentialAuthenticator,
  type SearchTokenCredential,
} from '../search/auth.js';
import { AzureOpenAIEmbeddingProvider } from './azureOpenAIEmbeddingProvider.js';
import { FileEmbeddingCache, InMemoryEmbeddingCache, type EmbeddingCache } from './cache.js';
import { CachingEmbeddingProvider } from './cachingEmbeddingProvider.js';
import type { CountTokens } from './input.js';

/** The embedding settings the provider needs (see embeddingConfigSchema). */
export type EmbeddingSettings = Pick<
  EmbeddingConfig,
  | 'AZURE_OPENAI_ENDPOINT'
  | 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT'
  | 'AZURE_OPENAI_API_KEY'
  | 'AZURE_OPENAI_TOKEN_SCOPE'
  | 'AZURE_OPENAI_EMBEDDING_MODEL'
  | 'AZURE_OPENAI_EMBEDDING_DIMENSIONS'
  | 'AZURE_OPENAI_EMBEDDING_SEND_DIMENSIONS'
  | 'EMBEDDING_VERSION'
  | 'EMBEDDING_BATCH_SIZE'
  | 'EMBEDDING_MAX_BATCH_TOKENS'
  | 'EMBEDDING_MAX_INPUT_TOKENS'
  | 'EMBEDDING_MAX_CONCURRENCY'
  | 'EMBEDDING_REQUESTS_PER_MINUTE'
  | 'EMBEDDING_REQUEST_TIMEOUT_MS'
  | 'EMBEDDING_MAX_RETRIES'
  | 'EMBEDDING_CACHE_DIR'
>;

export interface EmbeddingProviderDependencies {
  readonly logger?: Logger;
  readonly fetch?: HttpFetch;
  readonly countTokens?: CountTokens;
  /** Overrides DefaultAzureCredential; used by tests. */
  readonly createCredential?: () => Promise<SearchTokenCredential>;
  /** Overrides the cache chosen from EMBEDDING_CACHE_DIR. */
  readonly cache?: EmbeddingCache;
}

/**
 * The Azure OpenAI provider wrapped in a cache: a file cache when EMBEDDING_CACHE_DIR is set,
 * otherwise an in-memory one. An API key is used when configured (local development); otherwise
 * Microsoft Entra ID through DefaultAzureCredential (Managed Identity in Azure).
 */
export async function createEmbeddingProvider(
  settings: EmbeddingSettings,
  dependencies: EmbeddingProviderDependencies = {},
): Promise<CachingEmbeddingProvider> {
  const apiKey = settings.AZURE_OPENAI_API_KEY;
  const authenticator =
    apiKey !== undefined && apiKey !== ''
      ? apiKeyAuthenticator(apiKey)
      : tokenCredentialAuthenticator(
          await (dependencies.createCredential ?? createDefaultSearchCredential)(),
          settings.AZURE_OPENAI_TOKEN_SCOPE,
        );
  const provider = new AzureOpenAIEmbeddingProvider({
    endpoint: settings.AZURE_OPENAI_ENDPOINT,
    deployment: settings.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    modelIdentifier: settings.AZURE_OPENAI_EMBEDDING_MODEL,
    embeddingVersion: settings.EMBEDDING_VERSION,
    dimensions: settings.AZURE_OPENAI_EMBEDDING_DIMENSIONS,
    sendDimensions: settings.AZURE_OPENAI_EMBEDDING_SEND_DIMENSIONS,
    authenticator,
    batchSize: settings.EMBEDDING_BATCH_SIZE,
    maxBatchTokens: settings.EMBEDDING_MAX_BATCH_TOKENS,
    maxInputTokens: settings.EMBEDDING_MAX_INPUT_TOKENS,
    maxConcurrency: settings.EMBEDDING_MAX_CONCURRENCY,
    requestsPerMinute: settings.EMBEDDING_REQUESTS_PER_MINUTE,
    requestTimeoutMs: settings.EMBEDDING_REQUEST_TIMEOUT_MS,
    retryPolicy: {
      maxRetries: settings.EMBEDDING_MAX_RETRIES,
      baseDelayMs: 1_000,
      maxDelayMs: 20_000,
      maxRetryAfterMs: 60_000,
    },
    ...(dependencies.countTokens === undefined ? {} : { countTokens: dependencies.countTokens }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
  });
  const cache =
    dependencies.cache ??
    (settings.EMBEDDING_CACHE_DIR === undefined
      ? new InMemoryEmbeddingCache()
      : new FileEmbeddingCache(settings.EMBEDDING_CACHE_DIR));
  return new CachingEmbeddingProvider(provider, cache, dependencies.logger);
}
