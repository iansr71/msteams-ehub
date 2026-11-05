import { OpenTelemetryTelemetry, createLogger, resetTelemetry, setTelemetry } from '@ehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  API_CLIENT_ID,
  AUTHORITY,
  BOT_CLIENT_ID,
  NOW as TOKEN_NOW,
  TENANT as TOKEN_TENANT,
  createTokenKit,
  type TokenKit,
} from '../../apps/api/src/auth/__fixtures__/tokens.js';
import { EntraTokenValidator } from '../../apps/api/src/auth/entraTokenValidator.js';
import {
  FakeMoodle,
  moodleUser,
} from '../../apps/api/src/authorization/__fixtures__/fakeMoodle.js';
import { InMemoryAuthorizationCache } from '../../apps/api/src/authorization/authorizationCache.js';
import { AuthorizedCourseService } from '../../apps/api/src/authorization/authorizedCourseService.js';
import { InMemoryIdentityMappingRepository } from '../../apps/api/src/authorization/identityMappingRepository.js';
import { MoodleEnrollmentService } from '../../apps/api/src/authorization/moodleEnrollmentService.js';
import { MoodleIdentityResolver } from '../../apps/api/src/authorization/moodleIdentityResolver.js';
import { startApiServer, type RunningApiServer } from '../../apps/api/src/http/apiServer.js';
import { EntraBearerAuthenticator } from '../../apps/api/src/http/authentication.js';
import { AnswerSupportChecker } from '../../apps/api/src/rag/answerSupportChecker.js';
import { GroundedAnswerGenerator } from '../../apps/api/src/rag/groundedAnswerGenerator.js';
import { PromptBuilder } from '../../apps/api/src/rag/promptBuilder.js';
import { QuestionNormalizer } from '../../apps/api/src/rag/questionNormalizer.js';
import { RagService } from '../../apps/api/src/rag/ragService.js';
import { RetrievalOrchestrator } from '../../apps/api/src/rag/retrievalOrchestrator.js';
import {
  ScriptedChatModel,
  modelAnswer,
} from '../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import {
  SECRET_SENTENCE,
  TENANT_ID,
  seededSearch,
} from '../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { RetrievalService } from '../../apps/api/src/retrieval/retrievalService.js';
import {
  exportedMetricText,
  exportedSpanText,
  installTestOpenTelemetrySdk,
  type TestOpenTelemetrySdk,
} from '../../packages/shared/src/telemetry/__fixtures__/openTelemetrySdk.js';

/*
 * Prompt 16's redaction requirement, end to end: the real OpenTelemetry SDK records everything
 * the answer API emits while requests carry bearer tokens, cookies, API keys, a question, and
 * an answer built from source text. None of it may reach an exported span, metric or log line.
 */

const USER_OID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNMAPPED_OID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER_EMAIL = 'nomsa.dlamini@skinrenewal.example';
const UNMAPPED_EMAIL = 'pieter.vanwyk@personal.example';
const QUESTION = 'How often should sunscreen be reapplied after a peel for my client Thandeka?';
const COOKIE = 'session=cookie-secret-4f9a2b7c';
const API_KEY = 'api-key-secret-0123456789abcdef';
const FORGED_TOKEN = 'eyJmb3JnZWQiOiJ0b2tlbiJ9.forged-signature-secret';
const ANSWER_TEXT = 'Reapply sunscreen every two hours after a peel.';

let sdk: TestOpenTelemetrySdk;
let kit: TokenKit;
let server: RunningApiServer;
const logs: string[] = [];
const tokens: string[] = [];
const responses: string[] = [];

beforeAll(async () => {
  sdk = installTestOpenTelemetrySdk();
  setTelemetry(new OpenTelemetryTelemetry({ serviceName: 'ehub-api', version: '0.0.0' }));
  kit = await createTokenKit();

  const { client } = await seededSearch();
  const moodle = new FakeMoodle();
  moodle.users = [moodleUser(501, { email: USER_EMAIL, courses: [{ id: 12, visible: 1 }] })];
  const repository = new InMemoryIdentityMappingRepository();
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    sink: { write: (line) => logs.push(line) },
  });
  const resolver = new MoodleIdentityResolver({
    moodle,
    repository,
    emailMatching: true,
    upnRule: 'none',
    upnDomains: [],
    logger,
  });
  const model = new ScriptedChatModel(Array.from({ length: 10 }, () => modelAnswer()));
  server = await startApiServer(
    {
      answerer: new RagService({
        normalizer: new QuestionNormalizer(1000),
        orchestrator: new RetrievalOrchestrator({
          retrieval: new RetrievalService({
            search: client,
            settings: {
              topK: 8,
              maxChunksPerResource: 3,
              candidateCount: 24,
              semanticRanking: true,
              minScore: undefined,
              minRerankerScore: undefined,
            },
          }),
          minSupportingChunks: 1,
          minTopRerankerScore: undefined,
        }),
        promptBuilder: new PromptBuilder(12_000),
        generator: new GroundedAnswerGenerator({
          model,
          maxOutputTokens: 1200,
          maxAnswerChars: 4000,
          logger,
        }),
        modelName: model.getModelName(),
        supportChecker: new AnswerSupportChecker({ excerptChars: 300 }),
        allowedHosts: new Set(['ehub.example.test']),
        logger,
      }),
      authenticator: new EntraBearerAuthenticator(
        new EntraTokenValidator({
          allowedTenantIds: [TOKEN_TENANT],
          audiences: [API_CLIENT_ID],
          requiredScope: 'access_as_user',
          allowedClientAppIds: [BOT_CLIENT_ID],
          keys: kit.keys,
          authorityHost: AUTHORITY,
          clockToleranceSeconds: 120,
          currentDate: () => TOKEN_NOW,
        }),
      ),
      courseAccess: new AuthorizedCourseService({
        resolver,
        enrolments: new MoodleEnrollmentService(moodle),
        cache: new InMemoryAuthorizationCache({
          ttlMs: 60_000,
          maxEntries: 100,
          invalidations: repository,
          invalidationPollMs: 0,
          logger,
        }),
        staleGraceMs: 0,
        nodeEnv: 'production',
        logger,
      }),
      feedback: { record: () => Promise.resolve() },
      tenantId: TENANT_ID,
      requestTimeoutMs: 10_000,
      logger,
      service: 'ehub-api',
      version: '0.0.0',
    },
    { host: '127.0.0.1', port: 0 },
  );

  const send = async (authorization: string) => {
    const response = await fetch(`${server.url}/v1/answers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization,
        cookie: COOKIE,
        'x-api-key': API_KEY,
        'api-key': API_KEY,
        'ocp-apim-subscription-key': API_KEY,
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
      body: JSON.stringify({ question: QUESTION }),
    });
    const text = await response.text();
    responses.push(text);
    return response.status;
  };

  const mapped = await kit.sign({ oid: USER_OID, email: USER_EMAIL });
  const unmapped = await kit.sign({ oid: UNMAPPED_OID, email: UNMAPPED_EMAIL });
  tokens.push(mapped, unmapped);
  expect(await send(`Bearer ${mapped}`)).toBe(200);
  expect(await send(`Bearer ${unmapped}`)).toBe(403);
  expect(await send(`Bearer ${FORGED_TOKEN}`)).toBe(401);
  expect(await send('Basic dXNlcjpwYXNzd29yZA==')).toBe(401);
});

afterAll(async () => {
  await server.close();
  resetTelemetry();
  sdk.uninstall();
});

const NEVER_EXPORTED = (): [string, string][] => [
  ...tokens.map((token, index): [string, string] => [`signed token ${String(index)}`, token]),
  ...tokens.map((token, index): [string, string] => [
    `signed token ${String(index)} signature`,
    token.split('.')[2] ?? token,
  ]),
  ['forged token', FORGED_TOKEN],
  ['Bearer prefix', 'Bearer '],
  ['basic credentials', 'dXNlcjpwYXNzd29yZA=='],
  ['cookie', 'cookie-secret-4f9a2b7c'],
  ['API key', API_KEY],
  ['question', QUESTION],
  ['question fragment', 'Thandeka'],
  ['answer', ANSWER_TEXT],
  ['source text', SECRET_SENTENCE],
];

describe('telemetry redaction', () => {
  it('actually recorded the request path (so the checks below are not vacuous)', async () => {
    const names = new Set(sdk.spans().map((span) => span.name));
    for (const name of [
      'api.request',
      'auth.validate',
      'identity.resolve',
      'authorization.courses',
      'search.query',
      'citation.validate',
    ]) {
      expect(names, name).toContain(name);
    }
    const metricNames = exportedMetricText(await sdk.collect());
    for (const name of ['ehub.http.server.duration', 'ehub.auth.events', 'ehub.access.denials']) {
      expect(metricNames).toContain(name);
    }
    // The answer did contain the source-derived text: it was in the HTTP response.
    expect(responses[0]).toContain(ANSWER_TEXT);
  });

  it('keeps tokens, cookies, keys, questions, answers and source text out of spans', () => {
    const text = exportedSpanText(sdk.spans());
    for (const [label, secret] of NEVER_EXPORTED()) {
      expect(text.includes(secret), label).toBe(false);
    }
  });

  it('keeps them out of metrics', async () => {
    const text = exportedMetricText(await sdk.collect());
    for (const [label, secret] of NEVER_EXPORTED()) {
      expect(text.includes(secret), label).toBe(false);
    }
  });

  it('keeps them out of logs', () => {
    const text = logs.join('\n');
    for (const [label, secret] of NEVER_EXPORTED()) {
      expect(text.includes(secret), label).toBe(false);
    }
  });

  it('keeps user identities, URLs and header values out of spans and metrics', async () => {
    const text = exportedSpanText(sdk.spans()) + exportedMetricText(await sdk.collect());
    for (const value of [
      USER_EMAIL,
      UNMAPPED_EMAIL,
      USER_OID,
      UNMAPPED_OID,
      'skinrenewal.example',
      'ehub.example.test',
      '/v1/answers',
      '127.0.0.1',
    ]) {
      expect(text.includes(value), value).toBe(false);
    }
  });

  it('records no exception events, and failures only as category codes', () => {
    for (const span of sdk.spans()) {
      expect(span.events, span.name).toEqual([]);
      if (span.status.message !== undefined) {
        expect(span.status.message).toMatch(/^[a-z][a-z0-9_.]{0,47}$/);
      }
    }
    // A rejected token is a correct refusal, not a fault: the span says so by outcome and
    // reason code, and stays out of the failure rate.
    const auth = sdk.spans().filter((span) => span.name === 'auth.validate');
    expect(
      auth.map((span) => [span.attributes['ehub.outcome'], span.attributes['ehub.reason']]),
    ).toEqual([
      ['success', 'valid'],
      ['success', 'valid'],
      ['failure', expect.stringMatching(/^[a-z_]+$/)],
      ['failure', 'malformed_token'],
    ]);
  });
});
