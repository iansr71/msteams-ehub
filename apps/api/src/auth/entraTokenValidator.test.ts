import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@ehub/shared';
import { MOCK_IDENTITY_HEADER } from '@ehub/shared/answers';

import {
  createAuthenticator,
  EntraBearerAuthenticator,
  MockIdentityNotAllowedError,
  DevMockAuthenticator,
} from '../http/authentication.js';
import {
  API_CLIENT_ID,
  AUTHORITY,
  BOT_CLIENT_ID,
  NOW,
  OTHER_TENANT,
  TENANT,
  USER_OID,
  createTokenKit,
  unsignedToken,
  withForgedPayload,
  type TokenKit,
} from './__fixtures__/tokens.js';
import { EntraTokenValidator, type TokenValidationResult } from './entraTokenValidator.js';
import { InterimCourseAccess } from './courseAccess.js';

let kit: TokenKit;
let validator: EntraTokenValidator;

beforeAll(async () => {
  kit = await createTokenKit();
  validator = new EntraTokenValidator({
    allowedTenantIds: [TENANT],
    audiences: [API_CLIENT_ID, `api://${API_CLIENT_ID}`],
    requiredScope: 'access_as_user',
    allowedClientAppIds: [BOT_CLIENT_ID],
    keys: kit.keys,
    authorityHost: AUTHORITY,
    clockToleranceSeconds: 120,
    currentDate: () => NOW,
  });
});

function rejected(result: TokenValidationResult): { status: number; reason: string } {
  if (result.ok) {
    throw new Error('expected a rejection');
  }
  return { status: result.status, reason: result.reason };
}

const SECONDS = Math.floor(NOW.getTime() / 1000);

describe('Entra access token validation', () => {
  it('accepts a valid token and builds a normalised identity from its claims only', async () => {
    const result = await validator.validate(
      await kit.sign({ roles: ['E-Hub.Trainer', 'bad role!'], idp: undefined }),
    );
    expect(result).toEqual({
      ok: true,
      identity: {
        tenantId: TENANT,
        objectId: USER_OID,
        userPrincipalName: 'thandi@skinrenewal.example',
        email: 'thandi@skinrenewal.example',
        displayName: 'Thandi Test',
        roles: ['E-Hub.Trainer'],
        authentication: {
          method: 'entra-access-token',
          clientAppId: BOT_CLIENT_ID,
          scopes: ['access_as_user'],
          accountType: 'member',
        },
      },
    });
  });

  it('marks guests and keeps their home identity provider', async () => {
    const result = await validator.validate(
      await kit.sign({
        acct: 1,
        idp: 'https://sts.windows.net/9188040d-6c67-4c5b-b112-36a304b66dad/',
        upn: 'thandi_gmail.com#EXT#@skinrenewal.onmicrosoft.com',
      }),
    );
    expect(result.ok && result.identity.authentication).toMatchObject({
      accountType: 'guest',
      identityProvider: 'https://sts.windows.net/9188040d-6c67-4c5b-b112-36a304b66dad/',
    });
    expect(result.ok && result.identity.userPrincipalName).toBe(
      'thandi_gmail.com#EXT#@skinrenewal.onmicrosoft.com',
    );
  });

  it('accepts the App ID URI as audience and upper-case GUIDs', async () => {
    expect((await validator.validate(await kit.sign({ aud: `api://${API_CLIENT_ID}` }))).ok).toBe(
      true,
    );
    const upper = await validator.validate(await kit.sign({ oid: USER_OID.toUpperCase() }));
    expect(upper.ok && upper.identity.objectId).toBe(USER_OID);
  });

  it('rejects expired and not-yet-valid tokens, allowing the configured clock skew', async () => {
    expect(rejected(await validator.validate(await kit.sign({ exp: SECONDS - 121 })))).toEqual({
      status: 401,
      reason: 'token_expired',
    });
    expect((await validator.validate(await kit.sign({ exp: SECONDS - 60 }))).ok).toBe(true);
    expect(rejected(await validator.validate(await kit.sign({ nbf: SECONDS + 600 })))).toEqual({
      status: 401,
      reason: 'token_not_yet_valid',
    });
    expect(rejected(await validator.validate(await kit.sign({}, { remove: ['exp'] })))).toEqual({
      status: 401,
      reason: 'missing_claims',
    });
  });

  it('rejects a wrong issuer, including another tenant’s issuer and v1.0 tokens', async () => {
    for (const iss of [
      `https://sts.windows.net/${TENANT}/`,
      `https://login.evil.example/${TENANT}/v2.0`,
      `${AUTHORITY}/${OTHER_TENANT}/v2.0`,
    ]) {
      expect(rejected(await validator.validate(await kit.sign({ iss })))).toEqual({
        status: 401,
        reason: 'invalid_issuer',
      });
    }
    expect(rejected(await validator.validate(await kit.sign({ ver: '1.0' })))).toEqual({
      status: 401,
      reason: 'unsupported_token_version',
    });
  });

  it('rejects a wrong audience (e.g. a Graph token or the bot’s own token)', async () => {
    for (const aud of [
      '00000003-0000-0000-c000-000000000000',
      BOT_CLIENT_ID,
      [API_CLIENT_ID, BOT_CLIENT_ID],
    ]) {
      expect(rejected(await validator.validate(await kit.sign({ aud })))).toEqual({
        status: 401,
        reason: 'invalid_audience',
      });
    }
  });

  it('refuses another tenant with 403', async () => {
    const token = await kit.sign({ tid: OTHER_TENANT, iss: `${AUTHORITY}/${OTHER_TENANT}/v2.0` });
    expect(rejected(await validator.validate(token))).toEqual({
      status: 403,
      reason: 'tenant_not_allowed',
    });
  });

  it('requires a user object ID', async () => {
    expect(rejected(await validator.validate(await kit.sign({}, { remove: ['oid'] })))).toEqual({
      status: 401,
      reason: 'missing_object_id',
    });
    expect(rejected(await validator.validate(await kit.sign({ oid: 'not-a-guid' })))).toEqual({
      status: 401,
      reason: 'missing_object_id',
    });
  });

  it('requires a delegated user token with the API scope from an allowed client', async () => {
    expect(rejected(await validator.validate(await kit.sign({ scp: 'User.Read' })))).toEqual({
      status: 403,
      reason: 'insufficient_scope',
    });
    expect(
      rejected(
        await validator.validate(await kit.sign({ roles: ['Answers.Read'] }, { remove: ['scp'] })),
      ),
    ).toEqual({ status: 403, reason: 'not_a_user_token' });
    expect(rejected(await validator.validate(await kit.sign({ idtyp: 'app' })))).toEqual({
      status: 403,
      reason: 'not_a_user_token',
    });
    expect(
      rejected(
        await validator.validate(await kit.sign({ azp: '66666666-6666-4666-8666-666666666666' })),
      ),
    ).toEqual({ status: 403, reason: 'client_not_allowed' });
    expect(rejected(await validator.validate(await kit.sign({}, { remove: ['azp'] })))).toEqual({
      status: 403,
      reason: 'client_not_allowed',
    });
  });

  it('rejects a forged payload: identity claims swapped under a real signature', async () => {
    const forged = withForgedPayload(await kit.sign(), {
      oid: '77777777-7777-4777-8777-777777777777',
      roles: ['Admin'],
      tid: OTHER_TENANT,
    });
    expect(rejected(await validator.validate(forged))).toEqual({
      status: 401,
      reason: 'invalid_signature',
    });
  });

  it('rejects unsigned and wrongly signed tokens', async () => {
    expect(rejected(await validator.validate(unsignedToken()))).toEqual({
      status: 401,
      reason: 'malformed_token',
    });
    expect(rejected(await validator.validate(`${unsignedToken()}c2ln`))).toEqual({
      status: 401,
      reason: 'unsupported_algorithm',
    });
    expect(rejected(await validator.validate(await kit.signWithUnknownKey()))).toEqual({
      status: 401,
      reason: 'invalid_signature',
    });
    expect(rejected(await validator.validate(await kit.sign({}, { kid: 'other-key' })))).toEqual({
      status: 401,
      reason: 'unknown_signing_key',
    });
    // HMAC "signed" with a guessable secret: algorithm confusion is refused before verification.
    const hmac = await new SignJWT({ tid: TENANT })
      .setProtectedHeader({ alg: 'HS256', kid: 'trusted-key' })
      .sign(new TextEncoder().encode('secret-secret-secret-secret-1234'));
    expect(rejected(await validator.validate(hmac))).toEqual({
      status: 401,
      reason: 'unsupported_algorithm',
    });
    for (const junk of ['', 'abc', 'a.b', 'x'.repeat(20_000)]) {
      expect(rejected(await validator.validate(junk)).reason).toBe('malformed_token');
    }
  });

  it('fails closed with 503 when signing keys cannot be fetched', async () => {
    const offline = new EntraTokenValidator({
      allowedTenantIds: [TENANT],
      audiences: [API_CLIENT_ID],
      requiredScope: 'access_as_user',
      allowedClientAppIds: [BOT_CLIENT_ID],
      keys: () => Promise.reject(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com')),
      authorityHost: AUTHORITY,
      clockToleranceSeconds: 120,
      currentDate: () => NOW,
    });
    expect(await offline.validate(await kit.sign())).toEqual({
      ok: false,
      status: 503,
      reason: 'keys_unavailable',
    });
  });

  it('refuses empty allowlists', () => {
    expect(
      () =>
        new EntraTokenValidator({
          allowedTenantIds: [],
          audiences: [API_CLIENT_ID],
          requiredScope: 'access_as_user',
          allowedClientAppIds: [BOT_CLIENT_ID],
          keys: kit.keys,
          authorityHost: AUTHORITY,
          clockToleranceSeconds: 0,
        }),
    ).toThrow();
  });
});

describe('request authentication', () => {
  const logs: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    sink: { write: (line) => logs.push(line) },
  });

  it('reads only "Authorization: Bearer"', async () => {
    const bearer = new EntraBearerAuthenticator(validator);
    const token = await kit.sign();
    expect((await bearer.authenticate({ authorization: `Bearer ${token}` })).kind).toBe(
      'authenticated',
    );
    expect(await bearer.authenticate({})).toEqual({
      kind: 'unauthenticated',
      reason: 'missing_token',
    });
    for (const header of [`Basic ${token}`, `Bearer`, `Bearer ${token} extra`]) {
      expect(await bearer.authenticate({ authorization: header })).toEqual({
        kind: 'unauthenticated',
        reason: 'malformed_token',
      });
    }
    expect(
      await bearer.authenticate({ authorization: [`Bearer ${token}`, `Bearer ${token}`] }),
    ).toEqual({
      kind: 'unauthenticated',
      reason: 'malformed_token',
    });
  });

  it('disables the mock identity outside development automatically', async () => {
    for (const nodeEnv of ['production', 'test']) {
      const authenticator = createAuthenticator(
        { nodeEnv, tenantId: TENANT, mockIdentity: true, mockUserId: 'dev-mock-user' },
        logger,
      );
      expect(authenticator.mode).toBe('none');
      expect(await authenticator.authenticate({ [MOCK_IDENTITY_HEADER]: 'dev-mock-user' })).toEqual(
        { kind: 'not_configured' },
      );
      const withEntra = createAuthenticator(
        {
          nodeEnv,
          tenantId: TENANT,
          mockIdentity: true,
          mockUserId: 'dev-mock-user',
          entra: validator,
        },
        logger,
      );
      expect(withEntra.mode).toBe('entra');
      expect((await withEntra.authenticate({ [MOCK_IDENTITY_HEADER]: 'dev-mock-user' })).kind).toBe(
        'unauthenticated',
      );
      expect(
        () => new DevMockAuthenticator({ nodeEnv, userId: 'dev-mock-user', tenantId: TENANT }),
      ).toThrow(MockIdentityNotAllowedError);
    }
    expect(logs.join('\n')).toContain('API_DEV_MOCK_IDENTITY ignored');
  });

  it('keeps Entra and the mock apart in development', async () => {
    const both = createAuthenticator(
      {
        nodeEnv: 'development',
        tenantId: TENANT,
        mockIdentity: true,
        mockUserId: 'dev-mock-user',
        entra: validator,
      },
      logger,
    );
    expect(both.mode).toBe('entra+dev-mock');
    const token = await kit.sign();
    expect((await both.authenticate({ authorization: `Bearer ${token}` })).kind).toBe(
      'authenticated',
    );
    expect((await both.authenticate({ [MOCK_IDENTITY_HEADER]: 'dev-mock-user' })).kind).toBe(
      'authenticated',
    );
    expect(
      await both.authenticate({
        authorization: `Bearer ${token}`,
        [MOCK_IDENTITY_HEADER]: 'dev-mock-user',
      }),
    ).toEqual({
      kind: 'unauthenticated',
      reason: 'ambiguous_credentials',
    });
  });

  it('gives real users no courses until phase 14 unless a development list is set', async () => {
    const result = await new EntraBearerAuthenticator(validator).authenticate({
      authorization: `Bearer ${await kit.sign()}`,
    });
    if (result.kind !== 'authenticated') {
      throw new Error('expected authentication');
    }
    expect(
      await new InterimCourseAccess({
        nodeEnv: 'development',
        mockCourseIds: [12],
        devEntraCourseIds: [],
      }).resolve(result.caller),
    ).toEqual([]);
    expect(
      await new InterimCourseAccess({
        nodeEnv: 'development',
        mockCourseIds: [12],
        devEntraCourseIds: [15],
      }).resolve(result.caller),
    ).toEqual([15]);
    expect(
      await new InterimCourseAccess({
        nodeEnv: 'production',
        mockCourseIds: [12],
        devEntraCourseIds: [15],
      }).resolve(result.caller),
    ).toEqual([]);
  });
});
