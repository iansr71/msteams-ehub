import { redactString, sanitizeText } from '@ehub/shared';

import { factMatches, type EvaluationCase } from '../retrieval/evaluationCases.js';
import { answerHasValidSources } from './answerSupportChecker.js';
import type { RagAnswer, RagRequest } from './ragService.js';

/** The answer operation under evaluation. */
export interface Answerer {
  ask(request: RagRequest, options?: { readonly signal?: AbortSignal }): Promise<RagAnswer>;
}

export type AnswerCaseFailure =
  | 'error'
  | 'failed_answer'
  /** The required assertion: an answer must cite a valid source unless it is the explicit insufficient-evidence response. */
  | 'no_valid_source'
  /** A citation that does not map to a chunk the model was given. */
  | 'citation_not_in_sources'
  | 'unauthorized_citation'
  | 'forbidden_resource_cited'
  | 'expected_resource_not_cited'
  | 'expected_insufficient_evidence'
  | 'unexpected_insufficient_evidence'
  | 'missing_required_fact'
  | 'forbidden_fact_present'
  | 'conflict_not_reported'
  | 'unexpected_conflict'
  /** A value that must never be shown appeared in the answer (checked with `secretValues`). */
  | 'secret_in_output';

/**
 * How bad a failure is, following the evaluation rules in docs/acceptance.md:
 * - `critical`: content or secrets escaped their boundary. Never acceptable.
 * - `grounding`: the answer was not properly supported by its sources.
 * - `expectation`: the system behaved safely but not as the case expected (usually a
 *   retrieval or content problem, or an out-of-date case).
 * - `error`: the case could not be judged.
 */
export type FailureSeverity = 'critical' | 'grounding' | 'expectation' | 'error';

export const FAILURE_SEVERITY: Readonly<Record<AnswerCaseFailure, FailureSeverity>> = {
  secret_in_output: 'critical',
  unauthorized_citation: 'critical',
  forbidden_resource_cited: 'critical',
  no_valid_source: 'grounding',
  citation_not_in_sources: 'grounding',
  forbidden_fact_present: 'grounding',
  expected_resource_not_cited: 'expectation',
  expected_insufficient_evidence: 'expectation',
  unexpected_insufficient_evidence: 'expectation',
  missing_required_fact: 'expectation',
  conflict_not_reported: 'expectation',
  unexpected_conflict: 'expectation',
  failed_answer: 'error',
  error: 'error',
};

export function worstSeverity(failures: readonly AnswerCaseFailure[]): FailureSeverity | undefined {
  const order: readonly FailureSeverity[] = ['critical', 'grounding', 'error', 'expectation'];
  return order.find((severity) =>
    failures.some((failure) => FAILURE_SEVERITY[failure] === severity),
  );
}

export interface AnswerCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly status: RagAnswer['status'] | 'error';
  readonly failures: readonly AnswerCaseFailure[];
  readonly severity?: FailureSeverity;
  readonly citations: readonly {
    readonly citationId: number;
    readonly courseId: number;
    readonly resourceId: string;
    readonly moduleId: number;
  }[];
  readonly removedClaims: number;
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface AnswerEvaluationSummary {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly answered: number;
  readonly insufficientEvidence: number;
  readonly failedAnswers: number;
  readonly errors: number;
  /** Must be 0: answers returned without a valid source. */
  readonly answersWithoutValidSource: number;
  /** Must be 0: unauthorised content or a secret reached the answer. */
  readonly criticalFailures: number;
  readonly groundingFailures: number;
  readonly expectationFailures: number;
}

export interface AnswerEvaluationReport {
  readonly summary: AnswerEvaluationSummary;
  readonly cases: readonly AnswerCaseResult[];
}

function matches(citation: { resourceId: string; moduleId: number }, id: string): boolean {
  return citation.resourceId === id || String(citation.moduleId) === id;
}

/**
 * Asks each case's question as the simulated user and checks the answer. Every case asserts the
 * source invariant; cases with expectations also check which resources were cited, and whether
 * the answer should have been the insufficient-evidence response.
 */
export class AnswerEvaluationRunner {
  readonly #answerer: Answerer;
  readonly #tenantId: string;
  readonly #describeError: (error: unknown) => string;

  readonly #secretValues: readonly string[];

  constructor(options: {
    readonly answerer: Answerer;
    readonly tenantId: string;
    readonly describeError?: (error: unknown) => string;
    /**
     * Values that must never appear in an answer (tokens, keys, text from another course).
     * Empty by default: the deployed services rely on redaction and the security tests, and
     * handing real secrets to the runner would be its own risk.
     */
    readonly secretValues?: readonly string[];
  }) {
    this.#answerer = options.answerer;
    this.#tenantId = options.tenantId;
    this.#secretValues = options.secretValues ?? [];
    this.#describeError =
      options.describeError ?? ((error) => (error instanceof Error ? error.name : 'Error'));
  }

  async run(cases: readonly EvaluationCase[]): Promise<AnswerEvaluationReport> {
    const results: AnswerCaseResult[] = [];
    for (const testCase of cases) {
      results.push(await this.#runCase(testCase));
    }
    return {
      summary: {
        cases: results.length,
        passed: results.filter((result) => result.passed).length,
        failed: results.filter((result) => !result.passed).length,
        answered: results.filter((result) => result.status === 'answered').length,
        insufficientEvidence: results.filter((result) => result.status === 'insufficient_evidence')
          .length,
        failedAnswers: results.filter((result) => result.status === 'failed').length,
        errors: results.filter((result) => result.status === 'error').length,
        answersWithoutValidSource: results.filter((result) =>
          result.failures.includes('no_valid_source'),
        ).length,
        criticalFailures: results.filter((result) => result.severity === 'critical').length,
        groundingFailures: results.filter((result) => result.severity === 'grounding').length,
        expectationFailures: results.filter((result) => result.severity === 'expectation').length,
      },
      cases: results,
    };
  }

  async #runCase(testCase: EvaluationCase): Promise<AnswerCaseResult> {
    let answer: RagAnswer;
    try {
      answer = await this.#answerer.ask({
        question: testCase.question,
        user: {
          tenantId: this.#tenantId,
          userId: 'evaluation',
          authorizedCourseIds: testCase.authorizedCourseIds,
          ...(testCase.courseIds === undefined ? {} : { selectedCourseIds: testCase.courseIds }),
        },
      });
    } catch (error) {
      return {
        id: testCase.id,
        passed: false,
        status: 'error',
        failures: ['error'],
        severity: 'error',
        citations: [],
        removedClaims: 0,
        warnings: [],
        error: this.#describeError(error),
      };
    }

    const citations = answer.citations.map((citation) => ({
      citationId: citation.citationId,
      courseId: citation.courseId,
      resourceId: citation.resourceId,
      moduleId: citation.moduleId,
    }));
    const failures: AnswerCaseFailure[] = [];
    if (answer.status === 'failed') {
      failures.push('failed_answer');
    } else if (!answerHasValidSources(answer)) {
      failures.push('no_valid_source');
    }
    const allowed = new Set(testCase.courseIds ?? testCase.authorizedCourseIds);
    if (citations.some((citation) => !allowed.has(citation.courseId))) {
      failures.push('unauthorized_citation');
    }
    if (
      citations.some((citation) =>
        testCase.forbiddenResourceIds.some((id) => matches(citation, id)),
      )
    ) {
      failures.push('forbidden_resource_cited');
    }
    // Rule 5: a citation must map to a chunk the model was actually given.
    const sourceResourceIds = new Set(answer.sources.map((source) => source.resourceId));
    if (citations.some((citation) => !sourceResourceIds.has(citation.resourceId))) {
      failures.push('citation_not_in_sources');
    }
    if (testCase.expectInsufficientEvidence) {
      if (answer.status === 'answered') {
        failures.push('expected_insufficient_evidence');
      }
    } else if (testCase.expectedResourceIds.length > 0) {
      if (answer.status === 'insufficient_evidence') {
        failures.push('unexpected_insufficient_evidence');
      } else if (
        answer.status === 'answered' &&
        !citations.some((citation) =>
          testCase.expectedResourceIds.some((id) => matches(citation, id)),
        )
      ) {
        failures.push('expected_resource_not_cited');
      }
    }

    // Facts are matched against the answer and its claims together: a claim is the material
    // statement, and the answer text is what the user reads.
    const answerText = [answer.answer, ...answer.claims.map((claim) => claim.text)].join('\n');
    if (
      answer.status === 'answered' &&
      testCase.requiredFacts.some((fact) => !factMatches(fact, answerText))
    ) {
      failures.push('missing_required_fact');
    }
    if (testCase.forbiddenFacts.some((fact) => factMatches(fact, answerText))) {
      failures.push('forbidden_fact_present');
    }
    if (testCase.expectConflictingSources !== undefined && answer.status === 'answered') {
      if (testCase.expectConflictingSources && !answer.conflictingSources) {
        failures.push('conflict_not_reported');
      } else if (!testCase.expectConflictingSources && answer.conflictingSources) {
        failures.push('unexpected_conflict');
      }
    }
    // Rule 7: anything that must never be shown. Checked over everything the caller sees.
    const shown = [answerText, ...citations.map((citation) => citation.resourceId)].join('\n');
    if (this.#secretValues.some((secret) => secret !== '' && shown.includes(secret))) {
      failures.push('secret_in_output');
    }

    const severity = worstSeverity(failures);
    return {
      id: testCase.id,
      passed: failures.length === 0,
      status: answer.status,
      failures,
      ...(severity === undefined ? {} : { severity }),
      citations,
      removedClaims: answer.removedClaims,
      warnings: [...answer.warnings],
    };
  }
}

/** Counts, IDs and statuses only: never questions, answers or excerpts. */
export function renderAnswerEvaluationText(report: AnswerEvaluationReport): string {
  const lines = report.cases.map((result) => {
    const cited = result.citations
      .map(
        (citation) => `[${String(citation.citationId)}] ${sanitizeText(citation.resourceId, 120)}`,
      )
      .join(', ');
    return `${result.passed ? 'PASS' : `FAIL/${result.severity ?? 'unknown'}`} ${result.id} ${result.status}${result.failures.length === 0 ? '' : ` (${result.failures.join(', ')})`}${cited === '' ? '' : ` cites ${cited}`}${result.error === undefined ? '' : ` error: ${sanitizeText(result.error, 200)}`}`;
  });
  const { summary } = report;
  lines.push(
    '',
    `Cases: ${String(summary.cases)} | passed ${String(summary.passed)} | failed ${String(summary.failed)}`,
    `Answered ${String(summary.answered)} | insufficient evidence ${String(summary.insufficientEvidence)} | failed answers ${String(summary.failedAnswers)} | errors ${String(summary.errors)}`,
    `Answers without a valid source: ${String(summary.answersWithoutValidSource)} (must be 0)`,
    `Critical ${String(summary.criticalFailures)} (must be 0) | grounding ${String(summary.groundingFailures)} | expectation ${String(summary.expectationFailures)}`,
  );
  return redactString(lines.join('\n'));
}
