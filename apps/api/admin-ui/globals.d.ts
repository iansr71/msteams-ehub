// The parts of the MSAL Browser bundle (window.msal, served from /admin/vendor) the page uses.
declare namespace msal {
  interface AccountInfo {
    readonly username: string;
    readonly name?: string;
  }
  interface AuthenticationResult {
    readonly accessToken: string;
    readonly account: AccountInfo | null;
  }
  interface Configuration {
    readonly auth: {
      readonly clientId: string;
      readonly authority: string;
      readonly redirectUri: string;
    };
    readonly cache?: {
      readonly cacheLocation?: 'sessionStorage' | 'localStorage' | 'memoryStorage';
    };
  }
  class PublicClientApplication {
    constructor(configuration: Configuration);
    initialize(): Promise<void>;
    handleRedirectPromise(): Promise<AuthenticationResult | null>;
    getAllAccounts(): AccountInfo[];
    setActiveAccount(account: AccountInfo | null): void;
    loginRedirect(request: { readonly scopes: readonly string[] }): Promise<void>;
    logoutRedirect(request?: { readonly account?: AccountInfo }): Promise<void>;
    acquireTokenSilent(request: {
      readonly scopes: readonly string[];
      readonly account: AccountInfo;
    }): Promise<AuthenticationResult>;
    acquireTokenRedirect(request: { readonly scopes: readonly string[] }): Promise<void>;
  }
  class InteractionRequiredAuthError extends Error {}
}
