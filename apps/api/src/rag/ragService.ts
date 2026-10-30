import { createLogger, type Logger } from '@ehub/shared';
import { z } from 'zod';

import type { RetrievedChunk } from '../retrieval/retrievalResultMapper.js';
import type { RetrievalMode } from '../retrieval/searchQueryBuilder.js';
import { INSUFFICIENT_EVIDENCE_MESSAGE } from './answerSchema.js';
import { AnswerSupportChecker, type SupportWarning } from './answerSupportChecker.js';
import { isChatModelError, type ChatErrorCategory } from './chatModelProvider.js';
import type {
  GenerationFailure,
  GenerationResult,
  GroundedAnswerGenerator,
} from './groundedAnswerGenerator.js';
import type { PromptBuilder } from './promptBuilder.js';
import type { QuestionNormalizer } from './questionNormalizer.js';
import type {
  OrchestratedRetrieval,
  RetrievalOrchestrator,
  SupportShortfall,
} from './retrievalOrchestrator.js';

/** The authenticated caller, supplied by trusted code (Teams SSO and Moodle mapping later). */
export const userContextSchema = z.strictObject({
  tenantId: z.string().min(1),
  /** Opaque user ID, used for rate limiting only. */
  userId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/),
  authorizedCourseIds: z.array(z.number().int().positive()).max(1000),
  /** Optional narrowing, e.g. a course picker; must be within the authorised courses. */
  selectedCourseIds: z.array(z.number().int().positive()).min(1).max(1000).optional(),
});
export type UserContext = z.output<typeof userContextSchema>;

export interface RagRequest {
  readonly question: string;
  readonly user: UserContext;
}

/** Refuses before any retrieval: the caller has no (or not this) authorised scope. */
export class RagAuthorizationError extends Error {
  readonly code: 'invalid_user_context' | 'no_authorized_courses' | 'course_not_authorized';

  constructor(code: RagAuthorizationError['code'], message: string) {
    super(message);
    this.name = 'RagAuthorizationError';
    this.code = code;
  }
}

export class RagRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    super('Too many questions; try again shortly.');
    this.name = 'RagRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Hook for per-user limits (phase 17 adds a real implementation). */
export interface RagRateLimiter {
  check(userKey: string): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }>;
}

export const allowAllRateLimiter: RagRateLimiter = {
  check: () => Promise.resolve({ allowed: true }),
};

export interface RagSource {
  readonly chunkId: string;
  readonly courseId: number;
  readonly courseName: string;
  readonly sectionName: string;
  readonly moduleId: number;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly resourceType: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly pageNumber: number | undefined;
  readonly pageNumberEnd: number | undefined;
  readonly slideNumber: number | undefined;
  readonly sourceUrl: string | undefined;
  readonly moduleUrl: string | undefined;
  readonly rank: number;
}

export type RagStatus = 'answered' | 'insufficient_evidence' | 'failed';

export type RagFailureReason =
  GenerationFailure | `model_${ChatErrorCategory}` | 'retrieval_failed';

export interface RagAnswer {
  readonly status: RagStatus;
  /** The answer, the fixed insufficient-evidence message, or a safe failure message. */
  readonly answer: string;
  readonly claims: readonly { readonly text: string; readonly chunkIds: readonly string[] }[];
  readonly insufficientEvidence: boolean;
  readonly conflictingSources: boolean;
  readonly warnings: readonly (SupportWarning | SupportShortfall)[];
  readonly modelWarnings: readonly string[];
  /** Chunks given to the model, for citation validation (phase 10). */
  readonly sources: readonly RagSource[];
  readonly failureReason?: RagFailureReason;
  readonly retrieval?: {
    readonly mode: RetrievalMode;
    readonly candidates: number;
    readonly returned: number;
    readonly semanticApplied: boolean;
  };
  readonly model: string;
  readonly generationAttempts: number;
  readonly durationMs: number;
}

export const SAFE_FAILURE_MESSAGE =
  'Sorry, I could not produce a reliable answer right now. Please try again, or check the E-Hub course directly.';

export interface RagServiceOptions {
  readonly normalizer: QuestionNormalizer;
  readonly orchestrator: RetrievalOrchestrator;
  readonly promptBuilder: PromptBuilder;
  readonly generator: GroundedAnswerGenerator;
  readonly modelName: string;
  readonly supportChecker?: AnswerSupportChecker;
  readonly rateLimiter?: RagRateLimiter;
  readonly logger?: Logger;
}

const silentLogger = createLogger({ service: 'rag', level: 'silent' });

function toSource(chunk: RetrievedChunk): RagSource {
  return {
    chunkId: chunk.chunkId,
    courseId: chunk.courseId,
    courseName: chunk.courseName,
    sectionName: chunk.sectionName,
    moduleId: chunk.moduleId,
    resourceId: chunk.resourceId,
    resourceName: chunk.resourceName,
    resourceType: chunk.resourceType,
    title: chunk.title,
    headingPath: chunk.headingPath,
    pageNumber: chunk.pageNumber,
    pageNumberEnd: chunk.pageNumberEnd,
    slideNumber: chunk.slideNumber,
    sourceUrl: chunk.sourceUrl,
    moduleUrl: chunk.moduleUrl,
    rank: chunk.rank,
  };
}

/**
 * Validates the caller, normalises the question, retrieves within the authorised courses,
 * refuses weak evidence, builds a prompt from the authorised chunks only, generates and checks
 * the answer. Model or retrieval failures become a safe failure response, never a partial answer.
 */
export class RagService {
  readonly #options: RagServiceOptions;
  readonly #checker: AnswerSupportChecker;
  readonly #rateLimiter: RagRateLimiter;
  readonly #logger: Logger;

  constructor(options: RagServiceOptions) {
    this.#options = options;
    this.#checker = options.supportChecker ?? new AnswerSupportChecker();
    this.#rateLimiter = options.rateLimiter ?? allowAllRateLimiter;
    this.#logger = (options.logger ?? silentLogger).child({ component: 'rag' });
  }

  async ask(
    request: RagRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RagAnswer> {
    const started = Date.now();
    const user = this.#authorize(request.user);
    const limit = await this.#rateLimiter.check(`${user.tenantId}:${user.userId}`);
    if (!limit.allowed) {
      throw new RagRateLimitError(limit.retryAfterMs);
    }
    const question = this.#options.normalizer.normalize(request.question);

    const base = {
      model: this.#options.modelName,
      modelWarnings: [] as readonly string[],
      claims: [] as RagAnswer['claims'],
      conflictingSources: false,
    };
    const finish = (answer: RagAnswer): RagAnswer => {
      // Statuses and counts only: never the question or the answer.
      this.#logger.info('Question answered.', {
        status: answer.status,
        failureReason: answer.failureReason,
        questionCharacters: question.length,
        sources: answer.sources.length,
        claims: answer.claims.length,
        warnings: answer.warnings,
        generationAttempts: answer.generationAttempts,
        courses: user.selectedCourseIds?.length ?? user.authorizedCourseIds.length,
        durationMs: answer.durationMs,
      });
      return answer;
    };

    let retrieved: OrchestratedRetrieval;
    try {
      retrieved = await this.#options.orchestrator.retrieve(
        {
          question,
          tenantId: user.tenantId,
          authorizedCourseIds: user.authorizedCourseIds,
          ...(user.selectedCourseIds === undefined
            ? {}
            : { selectedCourseIds: user.selectedCourseIds }),
        },
        options,
      );
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error;
      }
      this.#logger.warn('Retrieval failed.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return finish({
        ...base,
        status: 'failed',
        answer: SAFE_FAILURE_MESSAGE,
        insufficientEvidence: false,
        warnings: [],
        sources: [],
        failureReason: 'retrieval_failed',
        generationAttempts: 0,
        durationMs: Date.now() - started,
      });
    }
    const retrieval = {
      mode: retrieved.retrieval.mode,
      candidates: retrieved.retrieval.candidates,
      returned: retrieved.retrieval.chunks.length,
      semanticApplied: retrieved.retrieval.semanticApplied,
    };
    if (retrieved.status === 'insufficient') {
      return finish({
        ...base,
        status: 'insufficient_evidence',
        answer: INSUFFICIENT_EVIDENCE_MESSAGE,
        insufficientEvidence: true,
        warnings: [retrieved.reason],
        sources: [],
        retrieval,
        generationAttempts: 0,
        durationMs: Date.now() - started,
      });
    }

    const prompt = this.#options.promptBuilder.build(question, retrieved.chunks);
    const sources = prompt.sources.map((source) => toSource(source.chunk));
    let generation: GenerationResult;
    try {
      generation = await this.#options.generator.generate(prompt, options.signal);
    } catch (error) {
      if (options.signal?.aborted === true || !isChatModelError(error)) {
        throw error;
      }
      return finish({
        ...base,
        status: 'failed',
        answer: SAFE_FAILURE_MESSAGE,
        insufficientEvidence: false,
        warnings: [],
        sources,
        retrieval,
        failureReason: `model_${error.category}`,
        generationAttempts: 1,
        durationMs: Date.now() - started,
      });
    }
    if (generation.kind === 'failed') {
      return finish({
        ...base,
        status: 'failed',
        answer: SAFE_FAILURE_MESSAGE,
        insufficientEvidence: false,
        warnings: [],
        sources,
        retrieval,
        failureReason: generation.reason,
        generationAttempts: generation.attempts,
        durationMs: Date.now() - started,
      });
    }

    const checked = this.#checker.check(generation.answer, prompt.sources);
    return finish({
      model: this.#options.modelName,
      status: checked.insufficientEvidence ? 'insufficient_evidence' : 'answered',
      answer: checked.answer,
      claims: checked.claims,
      insufficientEvidence: checked.insufficientEvidence,
      conflictingSources: checked.conflictingSources,
      warnings: checked.warnings,
      modelWarnings: checked.modelWarnings,
      sources,
      retrieval,
      generationAttempts: generation.attempts,
      durationMs: Date.now() - started,
    });
  }

  #authorize(input: UserContext): UserContext {
    const parsed = userContextSchema.safeParse(input);
    if (!parsed.success) {
      throw new RagAuthorizationError('invalid_user_context', 'The user context is invalid.');
    }
    const user = parsed.data;
    if (user.authorizedCourseIds.length === 0) {
      throw new RagAuthorizationError(
        'no_authorized_courses',
        'The user has no authorised courses.',
      );
    }
    const authorized = new Set(user.authorizedCourseIds);
    if (user.selectedCourseIds?.some((id) => !authorized.has(id)) === true) {
      throw new RagAuthorizationError(
        'course_not_authorized',
        'A selected course is not authorised for this user.',
      );
    }
    return user;
  }
}
