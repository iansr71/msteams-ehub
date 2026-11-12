import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { modelAnswer } from '../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import { NOW as TOKEN_NOW } from '../../apps/api/src/auth/__fixtures__/tokens.js';
import { USER_A, startAnswerApi, type AnswerApi } from '../security/__fixtures__/answerApi.js';

/*
 * Acceptance suite 12: only a valid Entra token from this tenant gets an answer, and identity
 * comes from the token rather than from anything the caller states. The rejection table in
 * docs/entra-sso.md is covered in detail by the unit tests; this suite is the acceptance view.
 */

let api: AnswerApi;
const QUESTION = 'How often should sunscreen be reapplied after a peel?';

/**
 * Changes the first character of a base64url signature, which always changes the signature
 * bytes. The last character carries unused trailing bits, so several values there decode to the
 * same bytes and would leave the token valid.
 */
function tamper(signature: string): string {
  return `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
}

beforeAll(async () => {
  api = await startAnswerApi();
  api.modelReplies(modelAnswer());
});
afterAll(async () => {
  await api.close();
});

describe('12 Entra authentication', () => {
  it('answers a signed-in member of the tenant', async () => {
    const token = await api.tokenFor(USER_A);
    const result = await api.ask(token, { question: QUESTION });
    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('answered');
  });

  it('refuses a request with no token', async () => {
    const result = await api.ask(undefined, { question: QUESTION });
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toContain('Bearer');
  });

  it.each([
    ['a token signed by someone else', 'forged'],
    ['an unsigned token', 'unsigned'],
    ['rubbish instead of a token', 'garbage'],
  ])('refuses %s', async (_label, kind) => {
    const valid = await api.tokenFor(USER_A);
    const [header, payload, signature] = valid.split('.');
    const token =
      kind === 'forged'
        ? `${header ?? ''}.${payload ?? ''}.${tamper(signature ?? '')}`
        : kind === 'unsigned'
          ? `${header ?? ''}.${payload ?? ''}.`
          : 'not-a-token';
    const result = await api.ask(token, { question: QUESTION });
    expect(result.status).toBe(401);
  });

  it('refuses an expired token', async () => {
    // The validator runs on the fixture's clock, so expiry is relative to that, not to now.
    const expired = Math.floor(TOKEN_NOW.getTime() / 1000) - 7_200;
    const token = await api.kit.sign({
      oid: USER_A.oid,
      email: USER_A.email,
      iat: expired - 60,
      nbf: expired - 60,
      exp: expired,
    });
    const result = await api.ask(token, { question: QUESTION });
    expect(result.status).toBe(401);
  });

  it('refuses a token for another tenant or another audience', async () => {
    for (const claims of [
      { tid: '99999999-9999-4999-8999-999999999999' },
      { aud: 'api://other' },
    ]) {
      const token = await api.kit.sign({ oid: USER_A.oid, email: USER_A.email, ...claims });
      const result = await api.ask(token, { question: QUESTION });
      expect([401, 403]).toContain(result.status);
    }
  });

  it('takes identity from the token, not from the request body', async () => {
    const token = await api.tokenFor(USER_A);
    const result = await api.ask(token, {
      question: QUESTION,
      userId: 'someone-else',
      objectId: '00000000-0000-4000-8000-000000000000',
    });
    // Unknown fields are refused outright rather than quietly ignored.
    expect(result.status).toBe(400);
  });

  it('never writes the token to the logs', async () => {
    const token = await api.tokenFor(USER_A);
    await api.ask(token, { question: QUESTION });
    const logs = api.logs.join('\n');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(token.split('.')[2] ?? 'signature');
  });
});
