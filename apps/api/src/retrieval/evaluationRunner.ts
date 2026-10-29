import type { SearchCallOptions } from '@ehub/shared/search';

import {
  describeChunk,
  type ChunkDiagnostic,
  type DiagnosticOptions,
} from './retrievalDiagnostics.js';
import type { RetrievedChunk } from './retrievalResultMapper.js';
import type { RetrievalResult } from './retrievalService.js';
import type { RetrievalMode, RetrievalRequest } from './searchQueryBuilder.js';
import type { EvaluationCase } from './evaluationCases.js';

/** The retrieval operation the runner evaluates. */
export interface Retriever {
  retrieve(request: RetrievalRequest, options?: SearchCallOptions): Promise<RetrievalResult>;
}

export interface EvaluatedChunk extends ChunkDiagnostic {
  readonly expected: boolean;
  readonly forbidden: boolean;
  readonly authorized: boolean;
}

export type CaseFailureReason =
  | 'error'
  | 'unauthorized_course'
  | 'forbidden_resource'
  | 'expected_resource_missing'
  | 'expected_course_missing';

export interface CaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly CaseFailureReason[];
  /** Rank of the first expected resource, if one was retrieved. */
  readonly firstExpectedRank: number | undefined;
  readonly results: readonly EvaluatedChunk[];
  /** Sanitised error message when retrieval failed. */
  readonly error?: string;
}

export interface EvaluationSummary {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** Cases with expected resources; the metrics below are computed over these. */
  readonly scoredCases: number;
  readonly hitAt1: number;
  readonly hitAt3: number;
  readonly hitAt5: number;
  readonly meanReciprocalRank: number;
}

export interface EvaluationReport {
  readonly summary: EvaluationSummary;
  readonly cases: readonly CaseResult[];
}

export interface EvaluationRunnerOptions {
  readonly retriever: Retriever;
  readonly tenantId: string;
  readonly diagnostics?: DiagnosticOptions;
  readonly mode?: RetrievalMode;
  /** Errors that stop the whole run (e.g. bad credentials) rather than failing one case. */
  readonly isFatal?: (error: unknown) => boolean;
  /** Turns an error into a short, safe message; defaults to the error's class name. */
  readonly describeError?: (error: unknown) => string;
}

/** True when `id` names this chunk's resource ID or its Moodle activity (module) ID. */
export function matchesResource(chunk: RetrievedChunk, id: string): boolean {
  return chunk.resourceId === id || String(chunk.moduleId) === id;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

export function summarize(
  results: readonly CaseResult[],
  cases: readonly EvaluationCase[],
): EvaluationSummary {
  const scored = results.filter(
    (_result, index) => (cases[index]?.expectedResourceIds.length ?? 0) > 0,
  );
  const hitAt = (k: number): number =>
    scored.length === 0
      ? 0
      : round(
          scored.filter(
            (result) => result.firstExpectedRank !== undefined && result.firstExpectedRank <= k,
          ).length / scored.length,
        );
  const reciprocal = scored.reduce(
    (sum, result) =>
      sum + (result.firstExpectedRank === undefined ? 0 : 1 / result.firstExpectedRank),
    0,
  );
  return {
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    errored: results.filter((result) => result.failures.includes('error')).length,
    scoredCases: scored.length,
    hitAt1: hitAt(1),
    hitAt3: hitAt(3),
    hitAt5: hitAt(5),
    meanReciprocalRank: scored.length === 0 ? 0 : round(reciprocal / scored.length),
  };
}

/**
 * Runs each case through the retriever as the simulated user (its authorised courses) and
 * scores the result. Cases run one at a time so a large file cannot flood the search service.
 */
export class EvaluationRunner {
  readonly #options: EvaluationRunnerOptions;

  constructor(options: EvaluationRunnerOptions) {
    this.#options = options;
  }

  async run(
    cases: readonly EvaluationCase[],
    options: SearchCallOptions = {},
  ): Promise<EvaluationReport> {
    const results: CaseResult[] = [];
    for (const testCase of cases) {
      results.push(await this.#runCase(testCase, options));
    }
    return { summary: summarize(results, cases), cases: results };
  }

  async #runCase(testCase: EvaluationCase, options: SearchCallOptions): Promise<CaseResult> {
    let retrieval: RetrievalResult;
    try {
      retrieval = await this.#options.retriever.retrieve(
        {
          question: testCase.question,
          tenantId: this.#options.tenantId,
          authorizedCourseIds: testCase.authorizedCourseIds,
          ...(testCase.courseIds === undefined ? {} : { courseIds: testCase.courseIds }),
          ...(testCase.resourceTypes === undefined
            ? {}
            : { resourceTypes: testCase.resourceTypes }),
          ...(this.#options.mode === undefined ? {} : { mode: this.#options.mode }),
        },
        options,
      );
    } catch (error) {
      if (options.signal?.aborted === true || this.#options.isFatal?.(error) === true) {
        throw error;
      }
      return {
        id: testCase.id,
        passed: false,
        failures: ['error'],
        firstExpectedRank: undefined,
        results: [],
        error: (this.#options.describeError ?? defaultDescribeError)(error),
      };
    }

    const authorized = new Set(testCase.courseIds ?? testCase.authorizedCourseIds);
    const diagnostics = this.#options.diagnostics ?? { excerpts: false };
    const evaluated: EvaluatedChunk[] = retrieval.chunks.map((chunk) => ({
      ...describeChunk(chunk, diagnostics),
      expected: testCase.expectedResourceIds.some((id) => matchesResource(chunk, id)),
      forbidden: testCase.forbiddenResourceIds.some((id) => matchesResource(chunk, id)),
      authorized: authorized.has(chunk.courseId),
    }));

    const failures: CaseFailureReason[] = [];
    if (evaluated.some((chunk) => !chunk.authorized)) {
      failures.push('unauthorized_course');
    }
    if (evaluated.some((chunk) => chunk.forbidden)) {
      failures.push('forbidden_resource');
    }
    const firstExpected = evaluated.find((chunk) => chunk.expected);
    if (testCase.expectedResourceIds.length > 0 && firstExpected === undefined) {
      failures.push('expected_resource_missing');
    }
    if (
      testCase.expectedCourseIds.length > 0 &&
      !evaluated.some((chunk) => testCase.expectedCourseIds.includes(chunk.courseId))
    ) {
      failures.push('expected_course_missing');
    }
    return {
      id: testCase.id,
      passed: failures.length === 0,
      failures,
      firstExpectedRank: firstExpected?.rank,
      results: evaluated,
    };
  }
}

function defaultDescribeError(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
