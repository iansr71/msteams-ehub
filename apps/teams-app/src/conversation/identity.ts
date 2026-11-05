/**
 * How the bot proves who is asking. Teams message fields (`from.id`, `aadObjectId`, names) are
 * NOT used: the answer API trusts only an Entra ID access token it validates itself. The bot's
 * job is to obtain that token through Teams single sign-on and pass it on unread.
 */
export type CallerCredential =
  /** An Entra ID access token for the answer API, from Teams SSO. Opaque to the bot. */
  | { readonly kind: 'user-token'; readonly token: string }
  /** DEVELOPMENT ONLY: the explicit mock user. */
  | { readonly kind: 'dev-mock'; readonly userId: string };

/** Per-turn sign-in operations, implemented by the Teams adapter with the SDK's OAuth flow. */
export interface TurnSignIn {
  /** The user's token for the answer API when Teams already holds one; otherwise undefined. */
  token(): Promise<string | undefined>;
  /** Starts sign-in: a silent SSO token exchange, or a sign-in card when consent is needed. */
  start(): Promise<void>;
}

export type CredentialOutcome =
  | { readonly kind: 'credential'; readonly credential: CallerCredential }
  /** Sign-in has started; the turn resumes when Teams reports it complete. */
  | { readonly kind: 'sign_in_started' }
  | { readonly kind: 'unavailable' };

export type IdentityMode = 'entra-sso' | 'dev-mock' | 'none';

export interface CredentialOptions {
  /** False for button clicks: use an existing token, but do not start sign-in. */
  readonly startSignIn: boolean;
}

export interface IdentityProvider {
  readonly mode: IdentityMode;
  credential(
    signIn: TurnSignIn | undefined,
    options: CredentialOptions,
  ): Promise<CredentialOutcome>;
}

/** Fails closed: nobody is identified, so no question reaches the API. */
export const noIdentityProvider: IdentityProvider = {
  mode: 'none',
  credential: () => Promise.resolve({ kind: 'unavailable' }),
};

/** Microsoft Entra ID single sign-on through Teams. */
export const ssoIdentityProvider: IdentityProvider = {
  mode: 'entra-sso',
  credential: async (signIn, options) => {
    if (signIn === undefined) {
      return { kind: 'unavailable' };
    }
    const token = await signIn.token();
    if (token !== undefined && token !== '') {
      return { kind: 'credential', credential: { kind: 'user-token', token } };
    }
    if (!options.startSignIn) {
      return { kind: 'unavailable' };
    }
    await signIn.start();
    return { kind: 'sign_in_started' };
  },
};

export class MockIdentityRefusedError extends Error {
  constructor() {
    super('The development mock identity is only allowed with NODE_ENV=development.');
    this.name = 'MockIdentityRefusedError';
  }
}

/** DEVELOPMENT ONLY. Every turn is treated as the configured mock user. */
export class MockIdentityProvider implements IdentityProvider {
  readonly mode = 'dev-mock' as const;
  readonly #credential: CallerCredential;

  constructor(options: { readonly nodeEnv: string; readonly userId: string }) {
    if (options.nodeEnv !== 'development' || !options.userId.startsWith('dev-mock-')) {
      throw new MockIdentityRefusedError();
    }
    this.#credential = { kind: 'dev-mock', userId: options.userId };
  }

  credential(): Promise<CredentialOutcome> {
    return Promise.resolve({ kind: 'credential', credential: this.#credential });
  }
}
