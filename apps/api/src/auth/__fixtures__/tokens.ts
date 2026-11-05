import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/*
 * Test tokens shaped like Microsoft Entra ID v2.0 access tokens, signed with a locally
 * generated key so tests run without network access.
 */

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
export const API_CLIENT_ID = '33333333-3333-4333-8333-333333333333';
export const BOT_CLIENT_ID = '44444444-4444-4444-8444-444444444444';
export const USER_OID = '55555555-5555-4555-8555-555555555555';
export const AUTHORITY = 'https://login.microsoftonline.com';
export const NOW = new Date('2026-11-05T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface TokenKit {
  readonly keys: JWTVerifyGetKey;
  /** The trusted public key as a JWKS document, for serving like Entra's discovery endpoint. */
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
  readonly sign: (
    claims?: Partial<JWTPayload> & Record<string, unknown>,
    options?: SignOptions,
  ) => Promise<string>;
  /** A key Entra never published: tokens signed with it must fail. */
  readonly signWithUnknownKey: (claims?: Record<string, unknown>) => Promise<string>;
}

export interface SignOptions {
  readonly kid?: string;
  readonly remove?: readonly string[];
}

export function baseClaims(): Record<string, unknown> {
  return {
    ver: '2.0',
    iss: `${AUTHORITY}/${TENANT}/v2.0`,
    aud: API_CLIENT_ID,
    tid: TENANT,
    oid: USER_OID,
    sub: 'pairwise-subject-value',
    azp: BOT_CLIENT_ID,
    scp: 'access_as_user',
    idtyp: 'user',
    preferred_username: 'thandi@skinrenewal.example',
    email: 'Thandi@SkinRenewal.example',
    name: 'Thandi Test',
    acct: 0,
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
  };
}

async function signWith(
  key: PrivateKey,
  kid: string,
  claims: Record<string, unknown>,
  remove: readonly string[],
): Promise<string> {
  const payload: Record<string, unknown> = { ...baseClaims(), ...claims };
  for (const name of remove) {
    Reflect.deleteProperty(payload, name);
  }
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid }).sign(key);
}

export async function createTokenKit(): Promise<TokenKit> {
  const trusted = await generateKeyPair('RS256', { extractable: true });
  const untrusted = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = {
    ...(await exportJWK(trusted.publicKey)),
    kid: 'trusted-key',
    alg: 'RS256',
    use: 'sig',
  };
  return {
    keys: createLocalJWKSet({ keys: [publicJwk] }),
    jwks: { keys: [{ ...publicJwk }] },
    sign: (claims = {}, options = {}) =>
      signWith(trusted.privateKey, options.kid ?? 'trusted-key', claims, options.remove ?? []),
    signWithUnknownKey: (claims = {}) => signWith(untrusted.privateKey, 'trusted-key', claims, []),
  };
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** An "alg: none" token: well-formed, with no signature. */
export function unsignedToken(claims: Record<string, unknown> = {}): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'trusted-key' }))}.${base64url(JSON.stringify({ ...baseClaims(), ...claims }))}.`;
}

/** Keeps the original header and signature but swaps the payload (a forged identity). */
export function withForgedPayload(token: string, claims: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.');
  const original = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  return `${header ?? ''}.${base64url(JSON.stringify({ ...original, ...claims }))}.${signature ?? ''}`;
}
