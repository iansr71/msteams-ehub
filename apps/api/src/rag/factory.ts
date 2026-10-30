import type { ChatConfig, Logger } from '@ehub/shared';
import type { HttpFetch } from '@ehub/shared/http';
import {
  apiKeyAuthenticator,
  createDefaultSearchCredential,
  tokenCredentialAuthenticator,
  type SearchTokenCredential,
} from '@ehub/shared/search';

import { AzureOpenAIChatProvider } from './azureOpenAIChatProvider.js';

export interface ChatProviderDependencies {
  readonly logger?: Logger;
  readonly fetch?: HttpFetch;
  readonly createCredential?: () => Promise<SearchTokenCredential>;
}

/**
 * The Azure OpenAI chat provider: API key when configured (local development), otherwise
 * Microsoft Entra ID through DefaultAzureCredential (Managed Identity in Azure).
 */
export async function createChatProvider(
  settings: ChatConfig,
  dependencies: ChatProviderDependencies = {},
): Promise<AzureOpenAIChatProvider> {
  const apiKey = settings.AZURE_OPENAI_API_KEY;
  const authenticator =
    apiKey !== undefined && apiKey !== ''
      ? apiKeyAuthenticator(apiKey)
      : tokenCredentialAuthenticator(
          await (dependencies.createCredential ?? createDefaultSearchCredential)(),
          settings.AZURE_OPENAI_TOKEN_SCOPE,
        );
  return new AzureOpenAIChatProvider({
    endpoint: settings.AZURE_OPENAI_ENDPOINT,
    deployment: settings.AZURE_OPENAI_CHAT_DEPLOYMENT,
    authenticator,
    responseFormat: settings.CHAT_RESPONSE_FORMAT,
    temperature: settings.CHAT_TEMPERATURE,
    requestTimeoutMs: settings.CHAT_REQUEST_TIMEOUT_MS,
    retryPolicy: {
      maxRetries: settings.CHAT_MAX_RETRIES,
      baseDelayMs: 1_000,
      maxDelayMs: 15_000,
      maxRetryAfterMs: 30_000,
    },
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
}
