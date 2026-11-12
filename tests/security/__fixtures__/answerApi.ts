import { createLogger } from '@ehub/shared';
import type { SearchDocument } from '@ehub/shared/search';

import {
  API_CLIENT_ID,
  AUTHORITY,
  BOT_CLIENT_ID,
  NOW as TOKEN_NOW,
  TENANT as TOKEN_TENANT,
  createTokenKit,
  type TokenKit,
} from '../../../apps/api/src/auth/__fixtures__/tokens.js';
import { EntraTokenValidator } from '../../../apps/api/src/auth/entraTokenValidator.js';
import {
  FakeMoodle,
  moodleUser,
} from '../../../apps/api/src/authorization/__fixtures__/fakeMoodle.js';
import { InMemoryAuthorizationCache } from '../../../apps/api/src/authorization/authorizationCache.js';
import { AuthorizedCourseService } from '../../../apps/api/src/authorization/authorizedCourseService.js';
import { InMemoryIdentityMappingRepository } from '../../../apps/api/src/authorization/identityMappingRepository.js';
import { MoodleEnrollmentService } from '../../../apps/api/src/authorization/moodleEnrollmentService.js';
import { MoodleIdentityResolver } from '../../../apps/api/src/authorization/moodleIdentityResolver.js';
import {
  startApiServer,
  type ApiServerOptions,
  type RunningApiServer,
} from '../../../apps/api/src/http/apiServer.js';
import { EntraBearerAuthenticator } from '../../../apps/api/src/http/authentication.js';
import { AnswerSupportChecker } from '../../../apps/api/src/rag/answerSupportChecker.js';
import type { ChatCompletionRequest } from '../../../apps/api/src/rag/chatModelProvider.js';
import { GroundedAnswerGenerator } from '../../../apps/api/src/rag/groundedAnswerGenerator.js';
import { PromptBuilder } from '../../../apps/api/src/rag/promptBuilder.js';
import { QuestionNormalizer } from '../../../apps/api/src/rag/questionNormalizer.js';
import { RagService } from '../../../apps/api/src/rag/ragService.js';
import { RetrievalOrchestrator } from '../../../apps/api/src/rag/retrievalOrchestrator.js';
import { ScriptedChatModel } from '../../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import {
  INDEX,
  TENANT_ID,
  seededSearch,
} from '../../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { RetrievalService } from '../../../apps/api/src/retrieval/retrievalService.js';

/*
 * The real answer API for attack tests: Entra token validation, Moodle identity and enrolment
 * checks, Azure AI Search (in-memory service behind the real client) and the real answer
 * engine. Only the chat model is scripted: each test decides what a model that obeyed the
 * attacker would output, and checks what the API does with it.
 */

export const ALLOWED_LINK_HOST = 'ehub.example.test';
export const USER_A = {
  oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'user.a@staff.example',
};
export const USER_B = {
  oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'user.b@staff.example',
};

export interface AnswerApi {
  readonly url: string;
  readonly kit: TokenKit;
  /** The fake Moodle behind authorisation: set enrolments, or switch failures on. */
  readonly moodle: FakeMoodle;
  /** Sets what the model returns for following questions (a string or a function of the request). */
  modelReplies(reply: string | ((request: ChatCompletionRequest) => string)): void;
  readonly modelRequests: ChatCompletionRequest[];
  readonly logs: string[];
  /** A signed token for a user; USER_A is enrolled in course 12, USER_B in course 13. */
  tokenFor(user: { oid: string; email: string }, claims?: Record<string, unknown>): Promise<string>;
  ask(
    token: string | undefined,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }>;
  close(): Promise<void>;
}

export async function startAnswerApi(
  options: {
    extraDocuments?: readonly SearchDocument[];
    maxQuestionChars?: number;
    limits?: ApiServerOptions['limits'];
    answererOverride?: ApiServerOptions['answerer'];
  } = {},
): Promise<AnswerApi> {
  const kit = await createTokenKit();
  const { client, service } = await seededSearch();
  if (options.extraDocuments !== undefined) {
    service.seed(INDEX, [...options.extraDocuments]);
  }
  const moodle = new FakeMoodle();
  moodle.users = [
    moodleUser(501, { email: USER_A.email, courses: [{ id: 12, visible: 1 }] }),
    moodleUser(502, { email: USER_B.email, courses: [{ id: 13, visible: 1 }] }),
  ];
  const repository = new InMemoryIdentityMappingRepository();
  const logs: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    sink: { write: (line) => logs.push(line) },
  });

  let reply: string | ((request: ChatCompletionRequest) => string) = () => {
    throw new Error('The test did not script a model reply.');
  };
  const modelRequests: ChatCompletionRequest[] = [];
  // One long script of functions that defer to the current `reply`.
  const model = new ScriptedChatModel(
    Array.from({ length: 200 }, () => (request: ChatCompletionRequest) => {
      modelRequests.push(request);
      return typeof reply === 'function' ? reply(request) : reply;
    }),
  );

  const rag = new RagService({
    normalizer: new QuestionNormalizer(options.maxQuestionChars ?? 1000),
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
    allowedHosts: new Set([ALLOWED_LINK_HOST]),
    logger,
  });

  const server: RunningApiServer = await startApiServer(
    {
      answerer: options.answererOverride ?? rag,
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
        resolver: new MoodleIdentityResolver({
          moodle,
          repository,
          emailMatching: true,
          upnRule: 'none',
          upnDomains: [],
          logger,
        }),
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
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      logger,
      service: 'ehub-api',
      version: '0.0.0',
    },
    { host: '127.0.0.1', port: 0 },
  );

  return {
    url: server.url,
    kit,
    modelReplies: (next) => {
      reply = next;
    },
    moodle,
    modelRequests,
    logs,
    tokenFor: (user, claims = {}) => kit.sign({ oid: user.oid, email: user.email, ...claims }),
    ask: async (token, body, headers = {}) => {
      const response = await fetch(`${server.url}/v1/answers`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return { status: response.status, body: parsed, text, headers: response.headers };
    },
    close: () => server.close(),
  };
}
