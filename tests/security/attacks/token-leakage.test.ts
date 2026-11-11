import { clearRegisteredSecretValues, registerSecretValue } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { withForgedPayload } from '../../../apps/api/src/auth/__fixtures__/tokens.js';
import { USER_A, startAnswerApi, type AnswerApi } from '../__fixtures__/answerApi.js';

/*
 * Attack tests: secrets escaping through errors. Dependencies fail with messages that contain
 * credentials (as real SDK and HTTP errors do); neither the HTTP response nor the logs may carry
 * them, and responses never include exception detail.
 */

const QUESTION = 'How often should sunscreen be reapplied after a peel?';

const MOODLE_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const API_KEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc';
const JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJvaWQiOiJhYmMiLCJzY3AiOiJhY2Nlc3NfYXNfdXNlciJ9.c2lnbmF0dXJlLXNlY3JldC12YWx1ZS0xMjM0NTY3ODkw';
const STORAGE_KEY =
  'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OQ==';

const SECRETS: [string, string][] = [
  ['Moodle token', MOODLE_TOKEN],
  ['API key', API_KEY],
  ['bearer token', JWT],
  ['bearer token signature', JWT.split('.')[2] ?? JWT],
  ['storage key', STORAGE_KEY],
];

const LEAKY_ERRORS: [string, () => Error][] = [
  [
    'a URL carrying the Moodle token',
    () =>
      new Error(
        `GET https://ehub.example.test/webservice/pluginfile.php/1/a.pdf?token=${MOODLE_TOKEN} failed: 500`,
      ),
  ],
  [
    'a web-service URL with wstoken',
    () =>
      new Error(
        `request to https://ehub.example.test/webservice/rest/server.php?wstoken=${MOODLE_TOKEN}&wsfunction=x failed`,
      ),
  ],
  ['an Authorization header', () => new Error(`401 for headers {"authorization":"Bearer ${JWT}"}`)],
  ['an api-key header', () => new Error(`Azure OpenAI rejected the request (api-key: ${API_KEY})`)],
  [
    'a storage connection string',
    () =>
      new Error(
        `DefaultEndpointsProtocol=https;AccountName=stehub;AccountKey=${STORAGE_KEY};EndpointSuffix=core.windows.net`,
      ),
  ],
  [
    'secrets in error properties and a cause',
    () =>
      Object.assign(
        new Error('upstream failed', {
          cause: new Error(`inner: client_secret=${API_KEY}`),
        }),
        {
          config: { headers: { Authorization: `Bearer ${JWT}`, 'api-key': API_KEY } },
          request: { url: `https://x.example/?token=${MOODLE_TOKEN}` },
        },
      ),
  ],
];

let api: AnswerApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

function expectNoSecrets(text: string, where: string): void {
  for (const [label, secret] of SECRETS) {
    expect(text.includes(secret), `${label} in ${where}`).toBe(false);
  }
}

describe('attack: token leakage through exceptions', () => {
  it.each(LEAKY_ERRORS)(
    'answers 500 without detail when a dependency fails with %s',
    async (_label, makeError) => {
      api = await startAnswerApi({
        answererOverride: { ask: () => Promise.reject(makeError()) },
      });
      const result = await api.ask(await api.tokenFor(USER_A), { question: QUESTION });

      expect(result.status).toBe(500);
      expect(Object.keys(result.body).sort()).toEqual(['correlationId', 'error']);
      expect(result.body['error']).toEqual({
        code: 'internal_error',
        message: expect.any(String) as string,
      });
      expectNoSecrets(result.text, 'the response');
      expect(result.text).not.toMatch(/\bat \S+ \(|node:internal|\.ts:\d+|stack/i);
      expect(result.text).not.toContain('ehub.example.test');

      // The failure is logged (so it can be investigated) but with every secret redacted.
      const logs = api.logs.join('\n');
      expect(logs).toContain('Request failed.');
      expectNoSecrets(logs, 'the logs');
    },
  );

  it('never logs or echoes the caller’s own bearer token, valid or not', async () => {
    api = await startAnswerApi({
      answererOverride: { ask: () => Promise.reject(new Error('boom')) },
    });
    const valid = await api.tokenFor(USER_A);
    const forged = withForgedPayload(valid, { oid: 'x' });
    const responses = [
      await api.ask(valid, { question: QUESTION }),
      await api.ask(forged, { question: QUESTION }),
      await api.ask('not-a-token', { question: QUESTION }),
    ];
    const everything =
      responses.map((r) => r.text + JSON.stringify([...r.headers])).join('\n') +
      api.logs.join('\n');
    for (const token of [valid, forged]) {
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(token.split('.')[2] ?? token);
      expect(everything).not.toContain(token.split('.')[1] ?? token);
    }
    expect(everything).not.toContain('not-a-token');
  });

  it('reports a model failure as a failed answer with no provider detail', async () => {
    // Every secret setting is registered when configuration loads (loadConfig), and is then
    // removed from anything logged, whatever text surrounds it.
    registerSecretValue(API_KEY);
    try {
      api = await startAnswerApi();
      api.modelReplies(() => {
        throw new Error(
          `Azure OpenAI 401: invalid key ${API_KEY} used for https://contoso.openai.azure.com`,
        );
      });
      const result = await api.ask(await api.tokenFor(USER_A), { question: QUESTION });
      expect([200, 500]).toContain(result.status);
      expectNoSecrets(result.text, 'the response');
      expect(result.text).not.toContain('contoso.openai.azure.com');
      expectNoSecrets(api.logs.join('\n'), 'the logs');
    } finally {
      clearRegisteredSecretValues();
    }
  });

  it('keeps the question and the answer out of the logs', async () => {
    api = await startAnswerApi();
    api.modelReplies(
      JSON.stringify({
        answer: 'Reapply sunscreen every two hours after a peel.',
        claims: [
          {
            text: 'Sunscreen should be reapplied every two hours after a peel.',
            sourceIds: ['S1'],
          },
        ],
        insufficientEvidence: false,
        conflictingSources: false,
        warnings: [],
      }),
    );
    const question =
      'My client Thandeka Mokoena had a reaction; how often is sunscreen reapplied after a peel?';
    const result = await api.ask(await api.tokenFor(USER_A), { question });
    expect(result.status).toBe(200);
    const logs = api.logs.join('\n');
    expect(logs).not.toContain('Thandeka');
    expect(logs).not.toContain('Mokoena');
    expect(logs).not.toContain('Reapply sunscreen every two hours');
    expect(logs).not.toContain(USER_A.email);
  });
});
