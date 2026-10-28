import { registerSecretValue } from '../logging/redaction.js';

export const SEARCH_TOKEN_SCOPE = 'https://search.azure.com/.default';

/** The part of @azure/identity's TokenCredential this client uses. */
export interface SearchTokenCredential {
  getToken(
    scopes: string | string[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

/** Supplies the authentication header for each request. */
export interface SearchAuthenticator {
  readonly mode: 'api-key' | 'entra-id';
  headers(signal?: AbortSignal): Promise<Readonly<Record<string, string>>>;
}

export class SearchCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchCredentialError';
  }
}

/** Admin API key. Intended for local development; deployed services use Entra ID. */
export function apiKeyAuthenticator(apiKey: string): SearchAuthenticator {
  if (apiKey.trim() === '') {
    throw new SearchCredentialError('The Azure AI Search API key is empty.');
  }
  registerSecretValue(apiKey);
  const headers = Object.freeze({ 'api-key': apiKey });
  return { mode: 'api-key', headers: () => Promise.resolve(headers) };
}

/** Microsoft Entra ID bearer tokens, e.g. from a Managed Identity. */
export function tokenCredentialAuthenticator(
  credential: SearchTokenCredential,
): SearchAuthenticator {
  return {
    mode: 'entra-id',
    headers: async (signal) => {
      let result: Awaited<ReturnType<SearchTokenCredential['getToken']>>;
      try {
        result = await credential.getToken(
          SEARCH_TOKEN_SCOPE,
          signal === undefined ? {} : { abortSignal: signal },
        );
      } catch {
        // The credential's own error can describe the environment in detail; keep it generic.
        throw new SearchCredentialError(
          'Could not obtain a Microsoft Entra ID token for Azure AI Search.',
        );
      }
      if (result === null || result.token === '') {
        throw new SearchCredentialError(
          'Could not obtain a Microsoft Entra ID token for Azure AI Search.',
        );
      }
      return { authorization: `Bearer ${result.token}` };
    },
  };
}

/**
 * DefaultAzureCredential: Managed Identity in Azure, developer sign-in (Azure CLI etc.)
 * locally. Loaded lazily so code paths that use an API key never load @azure/identity.
 */
export async function createDefaultSearchCredential(): Promise<SearchTokenCredential> {
  const { DefaultAzureCredential } = await import('@azure/identity');
  return new DefaultAzureCredential();
}
