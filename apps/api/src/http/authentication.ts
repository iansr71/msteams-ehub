import { MOCK_IDENTITY_HEADER } from '@ehub/shared/answers';

/** The caller as established by trusted code: never taken from the request body. */
export interface AuthenticatedCaller {
  readonly userId: string;
  readonly authorizedCourseIds: readonly number[];
  /** True for the development mock identity. */
  readonly mock: boolean;
}

export type AuthenticationResult =
  | { readonly kind: 'authenticated'; readonly caller: AuthenticatedCaller }
  | { readonly kind: 'unauthenticated' }
  /** No way to authenticate anyone is configured: every request is refused. */
  | { readonly kind: 'not_configured' };

export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Phase 13 adds an Entra ID implementation; until then only the development mock exists. */
export interface RequestAuthenticator {
  readonly mode: 'dev-mock' | 'none';
  authenticate(headers: RequestHeaders): AuthenticationResult;
}

/** Fails closed: used whenever no authentication is configured, including production. */
export const noAuthenticator: RequestAuthenticator = {
  mode: 'none',
  authenticate: () => ({ kind: 'not_configured' }),
};

export class MockIdentityNotAllowedError extends Error {
  constructor() {
    super('The development mock identity is only allowed with NODE_ENV=development.');
    this.name = 'MockIdentityNotAllowedError';
  }
}

/**
 * DEVELOPMENT ONLY. Accepts a request when it names the configured mock user in the
 * x-ehub-mock-identity header. The authorised courses come from this server's configuration,
 * never from the caller. Construction is refused outside NODE_ENV=development.
 */
export class DevMockAuthenticator implements RequestAuthenticator {
  readonly mode = 'dev-mock' as const;
  readonly #userId: string;
  readonly #courseIds: readonly number[];

  constructor(options: {
    readonly nodeEnv: string;
    readonly userId: string;
    readonly authorizedCourseIds: readonly number[];
  }) {
    if (options.nodeEnv !== 'development') {
      throw new MockIdentityNotAllowedError();
    }
    this.#userId = options.userId;
    this.#courseIds = [...options.authorizedCourseIds];
  }

  authenticate(headers: RequestHeaders): AuthenticationResult {
    const value = headers[MOCK_IDENTITY_HEADER];
    if (typeof value !== 'string' || value !== this.#userId) {
      return { kind: 'unauthenticated' };
    }
    return {
      kind: 'authenticated',
      caller: { userId: this.#userId, authorizedCourseIds: this.#courseIds, mock: true },
    };
  }
}
