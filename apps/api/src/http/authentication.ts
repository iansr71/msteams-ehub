import type { Logger } from '@ehub/shared';
import { MOCK_IDENTITY_HEADER } from '@ehub/shared/answers';

import type { EntraTokenValidator } from '../auth/entraTokenValidator.js';
import { mockIdentity, type UserIdentity } from '../auth/userIdentity.js';

/** The caller as established by trusted code: never taken from the request body. */
export interface AuthenticatedCaller {
  readonly identity: UserIdentity;
  /** True for the development mock identity. */
  readonly mock: boolean;
}

export type AuthenticationResult =
  | { readonly kind: 'authenticated'; readonly caller: AuthenticatedCaller }
  /** 401: no credentials, or credentials that are not valid for this API. */
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  /** 403: valid credentials, but this caller may not use the API. */
  | { readonly kind: 'forbidden'; readonly reason: string; readonly insufficientScope?: string }
  /** 503: credentials cannot be checked right now (signing keys unavailable). */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** No way to authenticate anyone is configured: every request is refused. */
  | { readonly kind: 'not_configured' };

export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export type AuthenticationMode = 'entra' | 'dev-mock' | 'entra+dev-mock' | 'none';

export interface RequestAuthenticator {
  readonly mode: AuthenticationMode;
  authenticate(headers: RequestHeaders): Promise<AuthenticationResult>;
}

/** Fails closed: used whenever no authentication is configured. */
export const noAuthenticator: RequestAuthenticator = {
  mode: 'none',
  authenticate: () => Promise.resolve({ kind: 'not_configured' }),
};

export class MockIdentityNotAllowedError extends Error {
  constructor() {
    super('The development mock identity is only allowed with NODE_ENV=development.');
    this.name = 'MockIdentityNotAllowedError';
  }
}

/** The header's value; null when it was sent more than once (always refused). */
function single(headers: RequestHeaders, name: string): string | undefined | null {
  const value = headers[name];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : null;
}

/** Microsoft Entra ID bearer tokens (`Authorization: Bearer <access token>`). */
export class EntraBearerAuthenticator implements RequestAuthenticator {
  readonly mode = 'entra' as const;
  readonly #validator: EntraTokenValidator;

  constructor(validator: EntraTokenValidator) {
    this.#validator = validator;
  }

  async authenticate(headers: RequestHeaders): Promise<AuthenticationResult> {
    const header = single(headers, 'authorization');
    if (header === undefined) {
      return { kind: 'unauthenticated', reason: 'missing_token' };
    }
    if (header === null) {
      return { kind: 'unauthenticated', reason: 'malformed_token' };
    }
    const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
    if (match?.[1] === undefined) {
      return { kind: 'unauthenticated', reason: 'malformed_token' };
    }
    const result = await this.#validator.validate(match[1]);
    if (result.ok) {
      return { kind: 'authenticated', caller: { identity: result.identity, mock: false } };
    }
    if (result.status === 503) {
      return { kind: 'unavailable', reason: result.reason };
    }
    if (result.status === 403) {
      return {
        kind: 'forbidden',
        reason: result.reason,
        ...(result.reason === 'insufficient_scope' ? { insufficientScope: 'required' } : {}),
      };
    }
    return { kind: 'unauthenticated', reason: result.reason };
  }
}

/**
 * DEVELOPMENT ONLY. Accepts a request that names the configured mock user in the
 * x-ehub-mock-identity header. Construction is refused outside NODE_ENV=development.
 */
export class DevMockAuthenticator implements RequestAuthenticator {
  readonly mode = 'dev-mock' as const;
  readonly #userId: string;
  readonly #identity: UserIdentity;

  constructor(options: {
    readonly nodeEnv: string;
    readonly userId: string;
    readonly tenantId: string;
  }) {
    if (options.nodeEnv !== 'development') {
      throw new MockIdentityNotAllowedError();
    }
    this.#userId = options.userId;
    this.#identity = mockIdentity(options.tenantId, options.userId);
  }

  authenticate(headers: RequestHeaders): Promise<AuthenticationResult> {
    const value = single(headers, MOCK_IDENTITY_HEADER);
    if (value !== this.#userId) {
      return Promise.resolve({ kind: 'unauthenticated', reason: 'invalid_mock_identity' });
    }
    return Promise.resolve({
      kind: 'authenticated',
      caller: { identity: this.#identity, mock: true },
    });
  }
}

/**
 * Development with SSO configured: a bearer token goes to Entra validation, the mock header to
 * the mock. A request carrying both is refused rather than guessing which one to trust.
 */
export class CombinedAuthenticator implements RequestAuthenticator {
  readonly mode = 'entra+dev-mock' as const;

  constructor(
    private readonly entra: EntraBearerAuthenticator,
    private readonly mock: DevMockAuthenticator,
  ) {}

  authenticate(headers: RequestHeaders): Promise<AuthenticationResult> {
    const hasToken = headers['authorization'] !== undefined;
    const hasMock = headers[MOCK_IDENTITY_HEADER] !== undefined;
    if (hasToken && hasMock) {
      return Promise.resolve({ kind: 'unauthenticated', reason: 'ambiguous_credentials' });
    }
    return hasMock ? this.mock.authenticate(headers) : this.entra.authenticate(headers);
  }
}

export interface AuthenticatorSettings {
  readonly nodeEnv: string;
  readonly tenantId: string;
  /** Entra validation, when ENTRA_* is configured. */
  readonly entra?: EntraTokenValidator;
  readonly mockIdentity: boolean;
  readonly mockUserId: string;
}

/**
 * Chooses how callers are authenticated. The mock identity is switched off automatically
 * outside development (with a warning), so a leftover variable can never enable it.
 */
export function createAuthenticator(
  settings: AuthenticatorSettings,
  logger: Logger,
): RequestAuthenticator {
  let mock: DevMockAuthenticator | undefined;
  if (settings.mockIdentity) {
    if (settings.nodeEnv === 'development') {
      mock = new DevMockAuthenticator({
        nodeEnv: settings.nodeEnv,
        userId: settings.mockUserId,
        tenantId: settings.tenantId,
      });
    } else {
      logger.warn(
        'API_DEV_MOCK_IDENTITY ignored: the mock identity only works with NODE_ENV=development.',
        {
          nodeEnv: settings.nodeEnv,
        },
      );
    }
  }
  const entra =
    settings.entra === undefined ? undefined : new EntraBearerAuthenticator(settings.entra);
  if (entra !== undefined && mock !== undefined) {
    return new CombinedAuthenticator(entra, mock);
  }
  return entra ?? mock ?? noAuthenticator;
}
