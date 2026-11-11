import {
  API_CLIENT_ID,
  AUTHORITY,
  BOT_CLIENT_ID,
  NOW as TOKEN_NOW,
  OTHER_TENANT,
  TENANT as TOKEN_TENANT,
  USER_OID,
  createTokenKit,
} from '../auth/__fixtures__/tokens.js';
import { EntraTokenValidator } from '../auth/entraTokenValidator.js';
import { InterimCourseAccess } from '../auth/courseAccess.js';
import { MOCK_OBJECT_ID } from '../auth/userIdentity.js';
import { InMemoryTelemetry, createLogger, resetTelemetry, setTelemetry } from '@ehub/shared';
import {
  MOCK_IDENTITY_HEADER,
  answerResponseSchema,
  apiErrorResponseSchema,
} from '@ehub/shared/answers';
import { afterEach, describe, expect, it } from 'vitest';

import type { ReadinessReport } from '../health/readiness.js';
import { ConcurrencyLimiter, SlidingWindowRateLimiter } from './requestLimits.js';

import { SECRET_SENTENCE, TENANT_ID, seededSearch } from '../retrieval/__fixtures__/corpus.js';
import { RetrievalService } from '../retrieval/retrievalService.js';
import { ScriptedChatModel, modelAnswer } from '../rag/__fixtures__/scriptedChatModel.js';
import { GroundedAnswerGenerator } from '../rag/groundedAnswerGenerator.js';
import { PromptBuilder } from '../rag/promptBuilder.js';
import { QuestionNormalizer } from '../rag/questionNormalizer.js';
import {
  RagAuthorizationError,
  RagRateLimitError,
  RagService,
  type RagAnswer,
  type RagRequest,
} from '../rag/ragService.js';
import { RetrievalOrchestrator } from '../rag/retrievalOrchestrator.js';
import {
  startApiServer,
  type ApiServerOptions,
  MAX_BODY_BYTES,
  type Answerer,
  type RunningApiServer,
} from './apiServer.js';
import {
  EntraBearerAuthenticator,
  DevMockAuthenticator,
  MockIdentityNotAllowedError,
  noAuthenticator,
  type RequestAuthenticator,
} from './authentication.js';
import {
  LoggingFeedbackRecorder,
  pseudonymousUserKey,
  type FeedbackEvent,
} from './feedbackRecorder.js';

const MOCK_USER = 'dev-mock-user';
const QUESTION = 'How often should sunscreen be reapplied after a peel?';

const running: RunningApiServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.close();
  }
});

function cannedAnswer(overrides: Partial<RagAnswer> = {}): RagAnswer {
  return {
    status: 'answered',
    answer: 'Reapply sunscreen every two hours. [1]',
    claims: [
      { text: 'Reapply sunscreen every two hours.', citationIds: [1], chunkIds: ['c'.repeat(64)] },
    ],
    citations: [
      {
        citationId: 1,
        chunkId: 'c'.repeat(64),
        courseId: 12,
        courseName: 'Consultation Standards',
        sectionName: 'Aftercare',
        moduleId: 701,
        resourceId: '701:chapter:11',
        resourceName: 'Sun protection',
        resourceType: 'moodle-book-chapter',
        pageNumber: undefined,
        pageNumberEnd: undefined,
        slideNumber: undefined,
        sourceUrl: 'https://ehub.example.test/mod/book/view.php?id=701&chapterid=11',
        excerpt: 'Reapply every two hours.',
      },
    ],
    removedClaims: 0,
    insufficientEvidence: false,
    conflictingSources: false,
    warnings: [],
    modelWarnings: [],
    sources: [],
    model: 'gpt-test',
    generationAttempts: 1,
    durationMs: 5,
    ...overrides,
  };
}

interface Harness {
  readonly url: string;
  readonly requests: RagRequest[];
  readonly feedback: FeedbackEvent[];
  readonly logs: string[];
}

async function serve(
  options: {
    answerer?: Answerer;
    authenticator?: RequestAuthenticator;
    requestTimeoutMs?: number;
    readiness?: { report(): Promise<ReadinessReport> };
    limits?: ApiServerOptions['limits'];
  } = {},
): Promise<Harness> {
  const requests: RagRequest[] = [];
  const feedback: FeedbackEvent[] = [];
  const logs: string[] = [];
  const answerer: Answerer = options.answerer ?? {
    ask: (request) => {
      requests.push(request);
      return Promise.resolve(cannedAnswer());
    },
  };
  const server = await startApiServer(
    {
      answerer: {
        ask: (request, askOptions) => {
          if (options.answerer !== undefined) {
            requests.push(request);
          }
          return answerer.ask(request, askOptions);
        },
      },
      authenticator:
        options.authenticator ??
        new DevMockAuthenticator({
          nodeEnv: 'development',
          userId: MOCK_USER,
          tenantId: TENANT_ID,
        }),
      courseAccess: new InterimCourseAccess({
        nodeEnv: 'development',
        mockCourseIds: [12, 15],
        devEntraCourseIds: [],
      }),
      feedback: {
        record: (event) => {
          feedback.push(event);
          return Promise.resolve();
        },
      },
      tenantId: TENANT_ID,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      logger: createLogger({
        service: 'test',
        level: 'trace',
        sink: { write: (line) => logs.push(line) },
      }),
      service: 'ehub-api',
      version: '0.1.0',
      clock: () => new Date('2026-11-04T10:00:00.000Z'),
    },
    { host: '127.0.0.1', port: 0 },
  );
  running.push(server);
  return { url: server.url, requests, feedback, logs };
}

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = { [MOCK_IDENTITY_HEADER]: MOCK_USER },
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('answer API', () => {
  it('answers with the public DTO, passing the server-side identity and correlation ID', async () => {
    const h = await serve();
    const response = await post(
      `${h.url}/v1/answers`,
      { question: QUESTION, selectedCourseIds: [15] },
      {
        [MOCK_IDENTITY_HEADER]: MOCK_USER,
        'x-correlation-id': 'teams-turn-123',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe('teams-turn-123');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = answerResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      answerId: 'teams-turn-123',
      status: 'answered',
      mockIdentity: true,
      citations: [{ citationId: 1, resourceName: 'Sun protection', moduleId: 701 }],
    });
    expect(JSON.stringify(body)).not.toContain('chunkId');
    expect(h.requests[0]?.user).toEqual({
      tenantId: TENANT_ID,
      userId: MOCK_OBJECT_ID,
      authorizedCourseIds: [12, 15],
      selectedCourseIds: [15],
    });
    // The question is never logged.
    expect(h.logs.join('\n')).not.toContain(QUESTION);
  });

  it('ignores identity claims in the body and generates a correlation ID when the header is unsafe', async () => {
    const h = await serve();
    const forged = await post(`${h.url}/v1/answers`, {
      question: QUESTION,
      user: { userId: 'admin', authorizedCourseIds: [99] },
    });
    expect(forged.status).toBe(400);
    expect(h.requests).toHaveLength(0);

    const unsafe = await post(
      `${h.url}/v1/answers`,
      { question: QUESTION },
      {
        [MOCK_IDENTITY_HEADER]: MOCK_USER,
        'x-correlation-id': 'bad id <script>',
      },
    );
    const id = unsafe.headers.get('x-correlation-id') ?? '';
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(((await unsafe.json()) as { answerId: string }).answerId).toBe(id);
  });

  it('fails closed without a valid identity', async () => {
    const h = await serve();
    for (const headers of [{}, { [MOCK_IDENTITY_HEADER]: 'dev-mock-someone-else' }]) {
      const response = await post(`${h.url}/v1/answers`, { question: QUESTION }, headers);
      expect(response.status).toBe(401);
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
        'unauthenticated',
      );
    }
    const none = await serve({ authenticator: noAuthenticator });
    const refused = await post(`${none.url}/v1/answers`, { question: QUESTION });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'authentication_not_configured',
    );
    expect(none.requests).toHaveLength(0);
    const health = (await (await fetch(`${none.url}/health`)).json()) as {
      status: string;
      identityMode: string;
    };
    expect(health).toMatchObject({ status: 'degraded', identityMode: 'none' });
  });

  it('refuses to construct the mock identity outside development', () => {
    for (const nodeEnv of ['production', 'test']) {
      expect(
        () => new DevMockAuthenticator({ nodeEnv, userId: MOCK_USER, tenantId: TENANT_ID }),
      ).toThrow(MockIdentityNotAllowedError);
    }
  });

  it('validates content type, size, JSON and method', async () => {
    const h = await serve();
    const textPlain = await fetch(`${h.url}/v1/answers`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', [MOCK_IDENTITY_HEADER]: MOCK_USER },
      body: 'hi',
    });
    expect(textPlain.status).toBe(415);
    expect((await post(`${h.url}/v1/answers`, 'x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await post(`${h.url}/v1/answers`, '{not json')).status).toBe(400);
    expect((await post(`${h.url}/v1/answers`, { question: '' })).status).toBe(400);
    const tooLong = await post(`${h.url}/v1/answers`, { question: 'x'.repeat(5_000) });
    expect(((await tooLong.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_question',
    );
    expect((await fetch(`${h.url}/v1/answers`)).status).toBe(405);
    expect((await fetch(`${h.url}/nope`)).status).toBe(404);
    expect(h.requests).toHaveLength(0);
  });

  it('maps authorisation, rate limit, timeout and unexpected errors', async () => {
    const cases: [Error, number, string][] = [
      [new RagAuthorizationError('course_not_authorized', 'x'), 403, 'course_not_authorized'],
      [new RagAuthorizationError('no_authorized_courses', 'x'), 403, 'no_authorized_courses'],
      [new RagRateLimitError(2_500), 429, 'rate_limited'],
      [new Error('database password=hunter2 exploded'), 500, 'internal_error'],
    ];
    for (const [error, status, code] of cases) {
      const h = await serve({ answerer: { ask: () => Promise.reject(error) } });
      const response = await post(`${h.url}/v1/answers`, { question: QUESTION });
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(apiErrorResponseSchema.parse(JSON.parse(text)).error.code).toBe(code);
      expect(text).not.toContain('hunter2');
      if (status === 429) {
        expect(response.headers.get('retry-after')).toBe('3');
      }
    }
    const slow = await serve({
      requestTimeoutMs: 50,
      answerer: {
        ask: (_request, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(options.signal?.reason as Error);
            });
          }),
      },
    });
    const timedOut = await post(`${slow.url}/v1/answers`, { question: QUESTION });
    expect(timedOut.status).toBe(504);
  });

  it('records feedback with the authenticated user, not the body', async () => {
    const h = await serve();
    const response = await post(`${h.url}/v1/feedback`, {
      answerId: 'teams-turn-123',
      rating: 'useful',
    });
    expect(response.status).toBe(202);
    expect(h.feedback).toEqual([
      {
        answerId: 'teams-turn-123',
        rating: 'useful',
        userId: MOCK_OBJECT_ID,
        receivedAt: '2026-11-04T10:00:00.000Z',
      },
    ]);
    expect((await post(`${h.url}/v1/feedback`, { answerId: 'x', rating: 'great' })).status).toBe(
      400,
    );
    expect(
      (await post(`${h.url}/v1/feedback`, { answerId: 'x', rating: 'useful' }, {})).status,
    ).toBe(401);
  });

  it('logs feedback pseudonymously', async () => {
    const logs: string[] = [];
    const recorder = new LoggingFeedbackRecorder(
      createLogger({ service: 'test', level: 'trace', sink: { write: (line) => logs.push(line) } }),
    );
    await recorder.record({
      answerId: 'a-1',
      rating: 'not_useful',
      userId: MOCK_USER,
      receivedAt: 'now',
    });
    expect(logs.join('\n')).toContain(pseudonymousUserKey(MOCK_USER));
    expect(logs.join('\n')).not.toContain(MOCK_USER);
  });

  it('serves real grounded answers from the RAG engine', async () => {
    const { client } = await seededSearch();
    const model = new ScriptedChatModel([modelAnswer()]);
    const logger = createLogger({ service: 'test', level: 'silent' });
    const rag = new RagService({
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
      allowedHosts: new Set(['ehub.example.test']),
      logger,
    });
    const h = await serve({ answerer: rag });
    const response = await post(`${h.url}/v1/answers`, { question: QUESTION });
    const body = answerResponseSchema.parse(await response.json());
    expect(body.status).toBe('answered');
    expect(body.citations.length).toBeGreaterThan(0);
    expect(
      body.citations.every((citation) => citation.courseId === 12 || citation.courseId === 15),
    ).toBe(true);
    expect(h.logs.join('\n')).not.toContain(SECRET_SENTENCE);
  });
});

describe('answer API with Entra ID tokens', () => {
  async function entraServer() {
    const kit = await createTokenKit();
    const validator = new EntraTokenValidator({
      allowedTenantIds: [TOKEN_TENANT],
      audiences: [API_CLIENT_ID],
      requiredScope: 'access_as_user',
      allowedClientAppIds: [BOT_CLIENT_ID],
      keys: kit.keys,
      authorityHost: AUTHORITY,
      clockToleranceSeconds: 120,
      currentDate: () => TOKEN_NOW,
    });
    const h = await serve({ authenticator: new EntraBearerAuthenticator(validator) });
    return { kit, h };
  }

  it('passes the validated object ID to the answer engine, never a body value', async () => {
    const { kit, h } = await entraServer();
    const token = await kit.sign();
    const response = await post(
      `${h.url}/v1/answers`,
      { question: QUESTION },
      { authorization: `Bearer ${token}` },
    );
    // The fake engine answers regardless of courses; course refusal is tested below.
    expect(response.status).toBe(200);
    expect(h.requests[0]?.user.userId).toBe(USER_OID);
    const forged = await post(
      `${h.url}/v1/answers`,
      {
        question: QUESTION,
        objectId: 'x',
        tenantId: 'y',
        roles: ['Admin'],
        email: 'boss@example.com',
      },
      { authorization: `Bearer ${token}` },
    );
    expect(forged.status).toBe(400);
    expect(h.requests).toHaveLength(1);
    const logs = h.logs.join('\n');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(token.split('.')[2] ?? 'never');
  });

  it('answers 401 with a Bearer challenge for missing or invalid tokens', async () => {
    const { kit, h } = await entraServer();
    const missing = await post(`${h.url}/v1/answers`, { question: QUESTION }, {});
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    const expired = await post(
      `${h.url}/v1/answers`,
      { question: QUESTION },
      {
        authorization: `Bearer ${await kit.sign({ exp: Math.floor(TOKEN_NOW.getTime() / 1000) - 3600 })}`,
      },
    );
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    const body = apiErrorResponseSchema.parse(await expired.json());
    expect(body.error.code).toBe('unauthenticated');
    expect(body.correlationId).toBe(expired.headers.get('x-correlation-id'));
    expect(
      h.logs.some(
        (line) =>
          line.includes('"reason":"token_expired"') &&
          line.includes(`"correlationId":"${body.correlationId}"`),
      ),
    ).toBe(true);
  });

  it('answers 403 for a valid token from a caller who may not use the API', async () => {
    const { kit, h } = await entraServer();
    const scope = await post(
      `${h.url}/v1/answers`,
      { question: QUESTION },
      { authorization: `Bearer ${await kit.sign({ scp: 'User.Read' })}` },
    );
    expect(scope.status).toBe(403);
    expect(scope.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="access_as_user"',
    );
    expect(apiErrorResponseSchema.parse(await scope.json()).error.code).toBe('forbidden');
    const tenant = await post(
      `${h.url}/v1/answers`,
      { question: QUESTION },
      {
        authorization: `Bearer ${await kit.sign({ tid: OTHER_TENANT, iss: `${AUTHORITY}/${OTHER_TENANT}/v2.0` })}`,
      },
    );
    expect(tenant.status).toBe(403);
    expect(h.requests).toHaveLength(0);
  });

  it('answers 403 "no access" for signed-in users without courses (phase 14 adds enrolments)', async () => {
    const kit = await createTokenKit();
    const logs: string[] = [];
    const rag = {
      ask: (request: RagRequest) =>
        Promise.reject(
          request.user.authorizedCourseIds.length === 0
            ? new RagAuthorizationError('no_authorized_courses', 'x')
            : new Error('unexpected'),
        ),
    };
    const server = await startApiServer(
      {
        answerer: rag,
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
        courseAccess: new InterimCourseAccess({
          nodeEnv: 'development',
          mockCourseIds: [12],
          devEntraCourseIds: [],
        }),
        feedback: { record: () => Promise.resolve() },
        tenantId: TENANT_ID,
        requestTimeoutMs: 5_000,
        logger: createLogger({
          service: 'test',
          level: 'trace',
          sink: { write: (line) => logs.push(line) },
        }),
        service: 'ehub-api',
        version: '0.1.0',
      },
      { host: '127.0.0.1', port: 0 },
    );
    running.push(server);
    const response = await post(
      `${server.url}/v1/answers`,
      { question: QUESTION },
      { authorization: `Bearer ${await kit.sign()}` },
    );
    expect(response.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'no_authorized_courses',
    );
  });
});

describe('health endpoints and telemetry', () => {
  afterEach(() => {
    resetTelemetry();
  });

  function report(status: ReadinessReport['status']): ReadinessReport {
    return {
      status,
      checkedAt: '2026-11-04T10:00:00.000Z',
      dependencies: [
        {
          name: 'search',
          required: true,
          status: status === 'ready' ? 'up' : 'down',
          latencyMs: 3,
          category: status === 'ready' ? null : 'timeout',
          checkedAt: '2026-11-04T10:00:00.000Z',
        },
      ],
    };
  }

  it('answers liveness without touching dependencies', async () => {
    let probed = 0;
    const h = await serve({
      readiness: {
        report: () => {
          probed += 1;
          return Promise.resolve(report('not_ready'));
        },
      },
    });
    const live = await fetch(`${h.url}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
    expect(probed).toBe(0);
    expect((await fetch(`${h.url}/health/live`, { method: 'POST' })).status).toBe(405);
  });

  it('reports readiness from the dependency checks', async () => {
    let current: ReadinessReport['status'] = 'ready';
    const h = await serve({ readiness: { report: () => Promise.resolve(report(current)) } });
    const ready = await fetch(`${h.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      identityConfigured: true,
      dependencies: [{ name: 'search', status: 'up' }],
    });
    current = 'not_ready';
    const down = await fetch(`${h.url}/health/ready`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      status: 'not_ready',
      dependencies: [{ name: 'search', status: 'down', category: 'timeout' }],
    });
  });

  it('is not ready without an identity provider, even when dependencies are up', async () => {
    const h = await serve({
      authenticator: noAuthenticator,
      readiness: { report: () => Promise.resolve(report('ready')) },
    });
    const response = await fetch(`${h.url}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'not_ready', identityConfigured: false });
  });

  it('continues the caller trace and records the request by route only', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const h = await serve();
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await post(
      `${h.url}/v1/answers`,
      { question: QUESTION },
      { [MOCK_IDENTITY_HEADER]: MOCK_USER, traceparent },
    );
    await post(`${h.url}/v1/answers`, { question: QUESTION }, {});
    expect(memory.remoteParents).toEqual([traceparent]);
    const spans = memory.spans.filter((span) => span.name === 'api.request');
    expect(spans.map((span) => span.attributes['http.response.status_code'])).toEqual([200, 401]);
    expect(spans[0]).toMatchObject({ kind: 'server', attributes: { 'ehub.route': 'answers' } });
    expect(
      memory.find('ehub.http.server.duration', { route: 'answers', status_class: '2xx' }),
    ).toHaveLength(1);
    expect(memory.sum('ehub.access.denials', { kind: 'unauthenticated' })).toBe(1);
    const recorded = JSON.stringify({
      spans: memory.spans.map((s) => s.attributes),
      metrics: memory.metrics,
    });
    expect(recorded).not.toContain(QUESTION);
    expect(recorded).not.toContain('/v1/answers');
    expect(recorded).not.toContain(MOCK_USER);
    expect(memory.dropped).toBe(0);
  });

  it('counts rate limiting as a rate-limit event', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const h = await serve({
      answerer: { ask: () => Promise.reject(new RagRateLimitError(1_000)) },
    });
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(429);
    expect(memory.sum('ehub.rate_limit.events', { dependency: 'answer_api' })).toBe(1);
  });

  it('marks a server error span failed with the error code', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const h = await serve({
      answerer: { ask: () => Promise.reject(new Error('https://moodle/?token=abc')) },
    });
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(500);
    expect(memory.spans.find((span) => span.name === 'api.request')).toMatchObject({
      status: 'error',
      failureCategory: 'internal_error',
    });
  });
});

describe('abuse limits', () => {
  afterEach(() => {
    resetTelemetry();
  });

  function limits(questions: number, feedback = 100, concurrent = 100) {
    return {
      questions: new SlidingWindowRateLimiter({ limit: questions, windowMs: 60_000 }),
      feedback: new SlidingWindowRateLimiter({ limit: feedback, windowMs: 60_000 }),
      concurrency: new ConcurrencyLimiter(concurrent),
    };
  }

  it('refuses questions beyond the per-user limit with 429 and Retry-After', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const h = await serve({ limits: limits(2) });
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(200);
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(200);
    const refused = await post(`${h.url}/v1/answers`, { question: QUESTION });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(h.requests).toHaveLength(2);
    expect(memory.sum('ehub.rate_limit.events', { dependency: 'answer_api' })).toBe(1);
  });

  it('does not count unauthenticated or refused requests against anyone', async () => {
    const h = await serve({ limits: limits(1) });
    for (let i = 0; i < 5; i += 1) {
      expect((await post(`${h.url}/v1/answers`, { question: QUESTION }, {})).status).toBe(401);
    }
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(200);
  });

  it('limits a rate-limited caller before reading the body', async () => {
    const h = await serve({ limits: limits(1) });
    await post(`${h.url}/v1/answers`, { question: QUESTION });
    // An invalid body would be 400; the limit is checked first.
    expect((await post(`${h.url}/v1/answers`, { nonsense: true })).status).toBe(429);
  });

  it('limits feedback separately from questions', async () => {
    const h = await serve({ limits: limits(1, 2) });
    const send = () => post(`${h.url}/v1/feedback`, { answerId: 'a-1', rating: 'useful' });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
    expect(h.feedback).toHaveLength(2);
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(200);
  });

  it('refuses answers beyond the concurrency cap and frees the slot afterwards', async () => {
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    const h = await serve({
      limits: limits(100, 100, 1),
      answerer: {
        ask: async () => {
          inFlight += 1;
          await started;
          return cannedAnswer();
        },
      },
    });
    const first = post(`${h.url}/v1/answers`, { question: QUESTION });
    while (inFlight === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const busy = await post(`${h.url}/v1/answers`, { question: QUESTION });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('2');
    release();
    expect((await first).status).toBe(200);
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(200);
  });

  it('frees the slot when the answer fails', async () => {
    let fail = true;
    const h = await serve({
      limits: limits(100, 100, 1),
      answerer: {
        ask: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(cannedAnswer())),
      },
    });
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(500);
    fail = false;
    expect((await post(`${h.url}/v1/answers`, { question: QUESTION })).status).toBe(200);
  });
});

describe('response headers and cross-origin requests', () => {
  it('sends strict headers on every JSON response, errors included', async () => {
    const h = await serve();
    for (const response of [
      await post(`${h.url}/v1/answers`, { question: QUESTION }),
      await post(`${h.url}/v1/answers`, { question: QUESTION }, {}),
      await fetch(`${h.url}/health`),
      await fetch(`${h.url}/nope`),
    ]) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(response.headers.get('strict-transport-security')).toMatch(/^max-age=31536000/);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('x-powered-by')).toBeNull();
    }
  });

  it('grants no other origin access: no CORS headers, preflight refused', async () => {
    const h = await serve();
    const preflight = await fetch(`${h.url}/v1/answers`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).toBe(405);
    const actual = await post(
      `${h.url}/v1/answers`,
      { question: QUESTION },
      { [MOCK_IDENTITY_HEADER]: MOCK_USER, origin: 'https://evil.example' },
    );
    for (const response of [preflight, actual]) {
      for (const [name] of response.headers) {
        expect(name.startsWith('access-control-')).toBe(false);
      }
    }
  });
});
