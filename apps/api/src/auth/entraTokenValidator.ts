import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

import { userIdentitySchema, type UserIdentity } from './userIdentity.js';

/*
 * Validates Microsoft Entra ID v2.0 access tokens issued for the answer API. Order matters:
 * the signature is verified before any claim is read for a decision, and every failure is a
 * fixed reason code (never token content).
 */

export type TokenRejection =
  // 401: the token is not a valid token for this API.
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'invalid_signature'
  | 'unknown_signing_key'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'unsupported_token_version'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'missing_object_id'
  | 'missing_claims'
  // 403: a valid token, but this caller may not use the API.
  | 'tenant_not_allowed'
  | 'client_not_allowed'
  | 'insufficient_scope'
  | 'not_a_user_token';

export const FORBIDDEN_REJECTIONS: ReadonlySet<TokenRejection> = new Set([
  'tenant_not_allowed',
  'client_not_allowed',
  'insufficient_scope',
  'not_a_user_token',
]);

export type TokenValidationResult =
  | { readonly ok: true; readonly identity: UserIdentity }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: TokenRejection }
  /** Signing keys could not be fetched: nothing can be validated (fail closed, 503). */
  | { readonly ok: false; readonly status: 503; readonly reason: 'keys_unavailable' };

export interface EntraTokenValidatorOptions {
  /** Tenants whose users may sign in; must include the organisation's tenant. */
  readonly allowedTenantIds: readonly string[];
  /** Accepted `aud` values: the API's client ID (v2 tokens) and optionally its App ID URI. */
  readonly audiences: readonly string[];
  /** The delegated scope every token must carry, e.g. `access_as_user`. */
  readonly requiredScope: string;
  /** Applications allowed to request tokens for the API (`azp`). */
  readonly allowedClientAppIds: readonly string[];
  /** Signing keys (the tenant's JWKS in production; a local key set in tests). */
  readonly keys: JWTVerifyGetKey;
  /** e.g. https://login.microsoftonline.com */
  readonly authorityHost: string;
  readonly clockToleranceSeconds: number;
  /** For tests. */
  readonly currentDate?: () => Date;
}

/** The largest token accepted; Entra access tokens are a few kilobytes. */
const MAX_TOKEN_CHARS = 16_384;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const stringList = z.array(z.string()).max(200);

const claimsSchema = z.looseObject({
  ver: z.string().optional(),
  iss: z.string().optional(),
  aud: z.union([z.string(), stringList]).optional(),
  tid: z.string().optional(),
  oid: z.string().optional(),
  sub: z.string().optional(),
  azp: z.string().optional(),
  appid: z.string().optional(),
  scp: z.string().optional(),
  roles: stringList.optional(),
  idtyp: z.string().optional(),
  upn: z.string().optional(),
  preferred_username: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  acct: z.union([z.number(), z.string()]).optional(),
  idp: z.string().optional(),
  amr: stringList.optional(),
});

/** The tenant's signing keys, cached and refreshed by jose. */
export function entraSigningKeys(authorityHost: string, tenantId: string): JWTVerifyGetKey {
  return createRemoteJWKSet(
    new URL(`${authorityHost.replace(/\/+$/, '')}/${tenantId}/discovery/v2.0/keys`),
    {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 60 * 60_000,
    },
  );
}

function bounded(value: string | undefined, max = 256): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' || trimmed.length > max ? undefined : trimmed;
}

export class EntraTokenValidator {
  readonly #options: EntraTokenValidatorOptions;
  readonly #tenants: ReadonlySet<string>;
  readonly #audiences: ReadonlySet<string>;
  readonly #clients: ReadonlySet<string>;
  readonly #authority: string;

  constructor(options: EntraTokenValidatorOptions) {
    if (
      options.allowedTenantIds.length === 0 ||
      options.audiences.length === 0 ||
      options.allowedClientAppIds.length === 0
    ) {
      throw new Error('Tenant, audience and client allowlists must not be empty.');
    }
    this.#options = options;
    this.#tenants = new Set(options.allowedTenantIds.map((id) => id.toLowerCase()));
    this.#audiences = new Set(options.audiences);
    this.#clients = new Set(options.allowedClientAppIds.map((id) => id.toLowerCase()));
    this.#authority = options.authorityHost.replace(/\/+$/, '');
  }

  async validate(token: string): Promise<TokenValidationResult> {
    const reject = (reason: TokenRejection): TokenValidationResult => ({
      ok: false,
      status: FORBIDDEN_REJECTIONS.has(reason) ? 403 : 401,
      reason,
    });

    if (token.length > MAX_TOKEN_CHARS || !JWT_SHAPE.test(token)) {
      return reject('malformed_token');
    }
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return reject('malformed_token');
    }
    // Entra signs access tokens with RS256; "none" and HMAC algorithms are never accepted.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      return reject('unsupported_algorithm');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#options.keys, {
        algorithms: ['RS256'],
        clockTolerance: this.#options.clockToleranceSeconds,
        requiredClaims: ['exp', 'nbf', 'iss', 'aud'],
        ...(this.#options.currentDate === undefined
          ? {}
          : { currentDate: this.#options.currentDate() }),
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        return reject('token_expired');
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        return reject(error.claim === 'nbf' ? 'token_not_yet_valid' : 'missing_claims');
      }
      if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
        return reject('invalid_signature');
      }
      if (
        error instanceof joseErrors.JWKSNoMatchingKey ||
        error instanceof joseErrors.JWKSMultipleMatchingKeys
      ) {
        return reject('unknown_signing_key');
      }
      if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
        return { ok: false, status: 503, reason: 'keys_unavailable' };
      }
      if (
        error instanceof joseErrors.JOSEAlgNotAllowed ||
        error instanceof joseErrors.JOSENotSupported
      ) {
        return reject('unsupported_algorithm');
      }
      if (error instanceof joseErrors.JWTInvalid || error instanceof joseErrors.JWSInvalid) {
        return reject('malformed_token');
      }
      // Network failures fetching the key set surface as plain errors.
      return { ok: false, status: 503, reason: 'keys_unavailable' };
    }

    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) {
      return reject('missing_claims');
    }
    const claims = parsed.data;
    if (claims.ver !== '2.0') {
      return reject('unsupported_token_version');
    }
    const tenantId = claims.tid?.toLowerCase();
    if (tenantId === undefined || !GUID.test(tenantId)) {
      return reject('missing_claims');
    }
    // The issuer must be Entra ID for the token's own tenant; a valid signature alone is not
    // enough, because Microsoft signs tokens for every tenant with the same keys.
    if (claims.iss !== `${this.#authority}/${tenantId}/v2.0`) {
      return reject('invalid_issuer');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      audiences.length !== 1 ||
      audiences[0] === undefined ||
      !this.#audiences.has(audiences[0])
    ) {
      return reject('invalid_audience');
    }
    if (!this.#tenants.has(tenantId)) {
      return reject('tenant_not_allowed');
    }
    if (claims.idtyp !== undefined && claims.idtyp !== 'user') {
      return reject('not_a_user_token');
    }
    if (claims.scp === undefined) {
      // Application (client-credentials) tokens carry roles but no delegated scopes.
      return reject('not_a_user_token');
    }
    const scopes = claims.scp.split(' ').filter((scope) => scope !== '');
    if (!scopes.includes(this.#options.requiredScope)) {
      return reject('insufficient_scope');
    }
    const clientAppId = (claims.azp ?? claims.appid)?.toLowerCase();
    if (clientAppId === undefined || !this.#clients.has(clientAppId)) {
      return reject('client_not_allowed');
    }
    const objectId = claims.oid?.toLowerCase();
    if (objectId === undefined || !GUID.test(objectId)) {
      return reject('missing_object_id');
    }
    if (bounded(claims.sub) === undefined) {
      return reject('missing_claims');
    }

    const email = bounded(claims.email)?.toLowerCase();
    const identity = userIdentitySchema.safeParse({
      tenantId,
      objectId,
      ...(bounded(claims.upn ?? claims.preferred_username) === undefined
        ? {}
        : { userPrincipalName: bounded(claims.upn ?? claims.preferred_username) }),
      ...(email !== undefined && z.email().safeParse(email).success ? { email } : {}),
      ...(bounded(claims.name) === undefined ? {} : { displayName: bounded(claims.name) }),
      roles: (claims.roles ?? [])
        .filter((role) => /^[A-Za-z0-9._-]{1,120}$/.test(role))
        .slice(0, 50),
      authentication: {
        method: 'entra-access-token',
        clientAppId,
        scopes: scopes.slice(0, 50),
        ...(claims.acct === undefined
          ? {}
          : { accountType: String(claims.acct) === '1' ? 'guest' : 'member' }),
        ...(bounded(claims.idp) === undefined ? {} : { identityProvider: bounded(claims.idp) }),
        ...(claims.amr === undefined
          ? {}
          : { methods: claims.amr.slice(0, 10).map((method) => method.slice(0, 40)) }),
      },
    });
    if (!identity.success) {
      return reject('missing_claims');
    }
    return { ok: true, identity: identity.data };
  }
}
