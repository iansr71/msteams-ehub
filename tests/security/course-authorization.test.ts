import { createLogger } from '@ehub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import { EnrolmentSyncJob } from '../../apps/api/src/authorization/enrolmentSyncJob.js';
import { InMemoryIdentityMappingRepository } from '../../apps/api/src/authorization/identityMappingRepository.js';
import { MoodleEnrollmentService } from '../../apps/api/src/authorization/moodleEnrollmentService.js';
import { MoodleIdentityResolver } from '../../apps/api/src/authorization/moodleIdentityResolver.js';
import { startApiServer, type RunningApiServer } from '../../apps/api/src/http/apiServer.js';
import { EntraBearerAuthenticator } from '../../apps/api/src/http/authentication.js';
import type { ChatCompletionRequest } from '../../apps/api/src/rag/chatModelProvider.js';
import { GroundedAnswerGenerator } from '../../apps/api/src/rag/groundedAnswerGenerator.js';
import { PromptBuilder } from '../../apps/api/src/rag/promptBuilder.js';
import { QuestionNormalizer } from '../../apps/api/src/rag/questionNormalizer.js';
import { RagService } from '../../apps/api/src/rag/ragService.js';
import { RetrievalOrchestrator } from '../../apps/api/src/rag/retrievalOrchestrator.js';
import {
  ScriptedChatModel,
  modelAnswer,
} from '../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import { TENANT_ID, seededSearch } from '../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { RetrievalService } from '../../apps/api/src/retrieval/retrievalService.js';
import type { FakeSearchService } from '../../packages/shared/src/search/__fixtures__/fakeSearchService.js';
import {
  SearchAuthorizationFilterBuilder,
  type SearchScopeError,
} from '../../packages/shared/src/search/authorizationFilter.js';

/*
 * Prompt 14's security cases, through the real answer API: Entra token validation, identity
 * mapping and enrolments (against a fake Moodle), the authorised-course filter inside the
 * search request (against the fake search service, which evaluates filters), and the model.
 *
 * Course 12 is "course A", course 13 "course B". The corpus is built so a laser question
 * matches course B's chunk best: if any path leaked course B, it would show.
 */

const COURSE_A = 12;
const COURSE_B = 13;
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_AMBIGUOUS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COURSE_B_TEXT = 'eye protection goggles';
const LASER_QUESTION = 'What eye protection is needed for laser treatments?';
const TTL_MS = 60_000;

let kit: TokenKit;
let clock: number;
let running: RunningApiServer | undefined;

beforeEach(async () => {
  kit = await createTokenKit();
  clock = TOKEN_NOW.getTime();
});

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function harness(options: { staleGraceMs?: number } = {}) {
  const { service: search, client } = await seededSearch();
  const moodle = new FakeMoodle();
  moodle.caseInsensitive = true;
  moodle.users = [
    moodleUser(501, { email: 'a@skinrenewal.example', courses: [{ id: COURSE_A, visible: 1 }] }),
    moodleUser(502, { email: 'b@skinrenewal.example', courses: [{ id: COURSE_B, visible: 1 }] }),
    moodleUser(503, {
      email: 'shared@skinrenewal.example',
      courses: [{ id: COURSE_B, visible: 1 }],
    }),
    moodleUser(504, {
      email: 'Shared@SkinRenewal.example',
      courses: [{ id: COURSE_B, visible: 1 }],
    }),
  ];
  const repository = new InMemoryIdentityMappingRepository({ now: () => new Date(clock) });
  const logs: string[] = [];
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
  const enrolments = new MoodleEnrollmentService(moodle);
  const courses = new AuthorizedCourseService({
    resolver,
    enrolments,
    cache: new InMemoryAuthorizationCache({
      ttlMs: TTL_MS,
      maxEntries: 100,
      invalidations: repository,
      invalidationPollMs: 0,
      logger,
      now: () => clock,
    }),
    staleGraceMs: options.staleGraceMs ?? 0,
    nodeEnv: 'production',
    logger,
  });
  const prompts: ChatCompletionRequest[] = [];
  const model = new ScriptedChatModel(
    Array.from({ length: 20 }, () => (request: ChatCompletionRequest) => {
      prompts.push(request);
      return modelAnswer();
    }),
  );
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
  running = await startApiServer(
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
      courseAccess: courses,
      feedback: { record: () => Promise.resolve() },
      tenantId: TENANT_ID,
      requestTimeoutMs: 10_000,
      logger,
      service: 'test',
      version: '0.0.0',
    },
    { host: '127.0.0.1', port: 0 },
  );
  const url = running.url;
  const ask = async (
    objectId: string,
    email: string,
    body: Record<string, unknown> = { question: LASER_QUESTION },
  ) => {
    const token = await kit.sign({ oid: objectId, email });
    const response = await fetch(`${url}/v1/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { ask, search, moodle, repository, prompts, logs, resolver, enrolments };
}

function searchFilters(search: FakeSearchService): string[] {
  return search.requests
    .filter((request) => request.method === 'POST' && request.path.endsWith('/docs/search'))
    .map((request) => String((JSON.parse(request.body) as { filter?: string }).filter));
}

function citedCourses(body: Record<string, unknown>): number[] {
  return ((body['citations'] as { courseId: number }[] | undefined) ?? []).map((c) => c.courseId);
}

describe('course authorisation (Prompt 14 security cases)', () => {
  it('user A can search course A', async () => {
    const h = await harness();
    const result = await h.ask(USER_A, 'a@skinrenewal.example', {
      question: 'How often should sunscreen be reapplied after a peel?',
    });
    expect(result.status).toBe(200);
    expect(result.body['status']).toBe('answered');
    expect(citedCourses(result.body).every((id) => id === COURSE_A)).toBe(true);
    expect(searchFilters(h.search)).toEqual([
      expect.stringContaining(`(courseId eq ${String(COURSE_A)})`),
    ]);
  });

  it('user A cannot retrieve course B: the filter is inside the search request', async () => {
    const h = await harness();
    // The laser question matches course B best; user A is enrolled in course A only.
    const result = await h.ask(USER_A, 'a@skinrenewal.example');
    const [filter] = searchFilters(h.search);
    expect(filter).toContain(`courseId eq ${String(COURSE_A)}`);
    expect(filter).not.toContain(`courseId eq ${String(COURSE_B)}`);
    // Nothing from course B reached the model or the answer (the model was asked once).
    expect(result.status).toBe(200);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts.map((prompt) => JSON.stringify(prompt.messages)).join('')).not.toContain(
      COURSE_B_TEXT,
    );
    expect(JSON.stringify(result.body)).not.toContain(COURSE_B_TEXT);
    expect(citedCourses(result.body)).not.toContain(COURSE_B);

    // User B, enrolled in course B, does get it: the difference is authorisation, not data.
    const b = await h.ask(USER_B, 'b@skinrenewal.example');
    expect(searchFilters(h.search)[1]).toContain(`courseId eq ${String(COURSE_B)}`);
    expect(b.status).toBe(200);
  });

  it('rejects a client-supplied course B with 403, before any search or model call', async () => {
    const h = await harness();
    for (const selectedCourseIds of [[COURSE_B], [COURSE_A, COURSE_B]]) {
      const result = await h.ask(USER_A, 'a@skinrenewal.example', {
        question: LASER_QUESTION,
        selectedCourseIds,
      });
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: 'course_not_authorized' } });
    }
    expect(searchFilters(h.search)).toEqual([]);
    expect(h.prompts).toEqual([]);
    // Within the authorised set, the selection narrows the filter.
    const ok = await h.ask(USER_A, 'a@skinrenewal.example', {
      question: 'sunscreen after a peel',
      selectedCourseIds: [COURSE_A],
    });
    expect(ok.status).toBe(200);
  });

  it('applies revocation once cached authorisation is invalidated', async () => {
    const h = await harness();
    expect(
      (await h.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' })).status,
    ).toBe(200);
    // Moodle removes the enrolment. Within the TTL the cached grant still stands…
    h.moodle.setCourses(501, []);
    expect(
      (await h.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' })).status,
    ).toBe(200);
    // …until an invalidation (here from the enrolment sync job) is written.
    clock += 1;
    const job = new EnrolmentSyncJob({
      repository: h.repository,
      resolver: h.resolver,
      enrolments: h.enrolments,
      logger: createLogger({ service: 'test', level: 'silent' }),
      now: () => new Date(clock),
    });
    expect(await job.run()).toMatchObject({ changed: 1 });
    clock += 1;
    const revoked = await h.ask(USER_A, 'a@skinrenewal.example', {
      question: 'sunscreen after a peel',
    });
    expect(revoked.status).toBe(403);
    expect(revoked.body).toMatchObject({ error: { code: 'no_authorized_courses' } });

    // An administrator invalidation works the same way, and so does TTL expiry.
    h.moodle.setCourses(501, [{ id: COURSE_A, visible: 1 }]);
    await h.repository.addInvalidation({
      scope: { tenantId: TOKEN_TENANT, objectId: USER_A },
      at: new Date(clock).toISOString(),
      reason: 'admin',
    });
    clock += 1;
    expect(
      (await h.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' })).status,
    ).toBe(200);
    h.moodle.setCourses(501, []);
    clock += TTL_MS;
    expect(
      (await h.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' })).status,
    ).toBe(403);
  });

  it('denies an ambiguous identity mapping, auditing it, without searching', async () => {
    const h = await harness();
    const result = await h.ask(USER_AMBIGUOUS, 'shared@skinrenewal.example');
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'identity_not_mapped' } });
    expect(searchFilters(h.search)).toEqual([]);
    expect(await h.repository.listFailures()).toEqual([
      expect.objectContaining({
        objectId: USER_AMBIGUOUS,
        reason: 'ambiguous_email',
        candidates: 2,
      }),
    ]);
    expect(h.logs.join('\n')).not.toContain('shared@skinrenewal');
  });

  it('does not grant stale access beyond the policy when Moodle lookups fail', async () => {
    const strict = await harness();
    expect(
      (await strict.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' }))
        .status,
    ).toBe(200);
    strict.moodle.failLookups = true;
    clock += TTL_MS;
    const refused = await strict.ask(USER_A, 'a@skinrenewal.example', {
      question: 'sunscreen after a peel',
    });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: { code: 'authorization_unavailable' } });
    // A user never seen before is refused too: an outage never becomes access.
    expect((await strict.ask(USER_B, 'b@skinrenewal.example')).status).toBe(503);
    expect(searchFilters(strict.search)).toHaveLength(1);
    await running?.close();
    running = undefined;

    clock = TOKEN_NOW.getTime();
    const lenient = await harness({ staleGraceMs: 30_000 });
    await lenient.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' });
    lenient.moodle.failCourses = true;
    clock += TTL_MS + 29_000;
    expect(
      (await lenient.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' }))
        .status,
    ).toBe(200);
    clock += 1_000;
    expect(
      (await lenient.ask(USER_A, 'a@skinrenewal.example', { question: 'sunscreen after a peel' }))
        .status,
    ).toBe(503);
  });
});

describe('search authorisation filter', () => {
  const builder = new SearchAuthorizationFilterBuilder();

  it('builds the course filter from the authorised set only', () => {
    expect(
      builder.build({ tenantId: TENANT_ID, authorizedCourseIds: [COURSE_A, COURSE_A] }),
    ).toEqual({
      filter: `tenantId eq '${TENANT_ID}' and isActive eq true and (courseId eq ${String(COURSE_A)})`,
      effectiveCourseIds: new Set([COURSE_A]),
    });
    expect(
      builder.build({
        tenantId: TENANT_ID,
        authorizedCourseIds: [COURSE_A, COURSE_B],
        selectedCourseIds: [COURSE_B],
      }).filter,
    ).toContain(`(courseId eq ${String(COURSE_B)})`);
  });

  it('refuses an empty scope, selections outside it and malformed values', () => {
    const cases: [Parameters<SearchAuthorizationFilterBuilder['build']>[0], string][] = [
      [{ tenantId: TENANT_ID, authorizedCourseIds: [] }, 'empty_scope'],
      [
        { tenantId: TENANT_ID, authorizedCourseIds: [COURSE_A], selectedCourseIds: [COURSE_B] },
        'course_not_authorized',
      ],
      [
        { tenantId: TENANT_ID, authorizedCourseIds: [COURSE_A], selectedCourseIds: [] },
        'invalid_query',
      ],
    ];
    for (const [scope, code] of cases) {
      expect(() => builder.build(scope)).toThrow(
        expect.objectContaining({ code }) as SearchScopeError,
      );
    }
    expect(() =>
      builder.build({ tenantId: "x' or true or '", authorizedCourseIds: [COURSE_A] }),
    ).toThrow();
    expect(() => builder.build({ tenantId: TENANT_ID, authorizedCourseIds: [1.5] })).toThrow();
  });
});
