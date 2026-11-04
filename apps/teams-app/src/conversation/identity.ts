/**
 * Who is asking. Teams message fields (`from.id`, `from.aadObjectId`, names) are NOT used: an
 * activity's sender is not proof of identity for our API, and phase 13 replaces this with an
 * Entra ID SSO token. Until then the only identity is an explicitly enabled development mock.
 */
export interface CallerIdentity {
  readonly kind: 'dev-mock';
  readonly userId: string;
}

export interface IdentityProvider {
  readonly mode: 'dev-mock' | 'none';
  /** The caller, or undefined when it cannot be established (the bot then refuses). */
  resolve(): CallerIdentity | undefined;
}

/** Fails closed: nobody is identified, so no question reaches the API. */
export const noIdentityProvider: IdentityProvider = {
  mode: 'none',
  resolve: () => undefined,
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
  readonly #identity: CallerIdentity;

  constructor(options: { readonly nodeEnv: string; readonly userId: string }) {
    if (options.nodeEnv !== 'development') {
      throw new MockIdentityRefusedError();
    }
    if (!options.userId.startsWith('dev-mock-')) {
      throw new MockIdentityRefusedError();
    }
    this.#identity = { kind: 'dev-mock', userId: options.userId };
  }

  resolve(): CallerIdentity {
    return this.#identity;
  }
}
