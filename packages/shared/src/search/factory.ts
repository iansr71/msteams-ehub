import type { Logger } from '../logging/logger.js';
import {
  apiKeyAuthenticator,
  createDefaultSearchCredential,
  tokenCredentialAuthenticator,
  type SearchTokenCredential,
} from './auth.js';
import { RestSearchIndexClient, type SearchIndexClient } from './client.js';
import { DEFAULT_SEARCH_RETRY_POLICY, type SearchFetch } from './http.js';

/** The validated AZURE_SEARCH_* settings (see azureSearchConfigSchema). */
export interface SearchClientSettings {
  readonly AZURE_SEARCH_ENDPOINT: string;
  readonly AZURE_SEARCH_INDEX_NAME: string;
  readonly AZURE_SEARCH_API_KEY?: string | undefined;
  readonly AZURE_SEARCH_VECTOR_DIMENSIONS: number;
  readonly AZURE_SEARCH_SEMANTIC_ENABLED: boolean;
  readonly AZURE_SEARCH_BATCH_SIZE: number;
  readonly AZURE_SEARCH_REQUEST_TIMEOUT_MS: number;
  readonly AZURE_SEARCH_MAX_RETRIES: number;
}

export interface SearchClientDependencies {
  readonly logger?: Logger;
  readonly fetch?: SearchFetch;
  /** Overrides DefaultAzureCredential; used by tests. */
  readonly createCredential?: () => Promise<SearchTokenCredential>;
}

/**
 * An API key is used when one is configured (local development); otherwise Microsoft Entra ID
 * through DefaultAzureCredential, which is Managed Identity in Azure.
 */
export async function createSearchIndexClient(
  settings: SearchClientSettings,
  dependencies: SearchClientDependencies = {},
): Promise<SearchIndexClient> {
  const apiKey = settings.AZURE_SEARCH_API_KEY;
  const authenticator =
    apiKey !== undefined && apiKey !== ''
      ? apiKeyAuthenticator(apiKey)
      : tokenCredentialAuthenticator(
          await (dependencies.createCredential ?? createDefaultSearchCredential)(),
        );
  return new RestSearchIndexClient({
    endpoint: settings.AZURE_SEARCH_ENDPOINT,
    indexName: settings.AZURE_SEARCH_INDEX_NAME,
    vectorDimensions: settings.AZURE_SEARCH_VECTOR_DIMENSIONS,
    semanticEnabled: settings.AZURE_SEARCH_SEMANTIC_ENABLED,
    authenticator,
    batchSize: settings.AZURE_SEARCH_BATCH_SIZE,
    requestTimeoutMs: settings.AZURE_SEARCH_REQUEST_TIMEOUT_MS,
    retryPolicy: { ...DEFAULT_SEARCH_RETRY_POLICY, maxRetries: settings.AZURE_SEARCH_MAX_RETRIES },
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
}
