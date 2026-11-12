import { describe, expect, it } from 'vitest';

import {
  evaluationFileSchema,
  factMatches,
  normalizeForMatching,
  type EvaluationCase,
} from '../retrieval/evaluationCases.js';
import {
  AnswerEvaluationRunner,
  FAILURE_SEVERITY,
  worstSeverity,
  type AnswerCaseFailure,
} from './answerEvaluationRunner.js';
import type { RagAnswer } from './ragService.js';

/*
 * Scoring rules for `pnpm evaluation:answers` (docs/acceptance.md). The runner decides whether a
 * case passed, so a mistake here would hide a real failure: every rule is tested directly, with
 * answers built by hand rather than by a model.
 */

import {
  FIXTURE_COURSE as COURSE,
  FIXTURE_RESOURCE as RESOURCE,
  fixtureAnswer as answerOf,
  fixtureInsufficientAnswer,
} from './__fixtures__/ragAnswers.js';

function parseCase(raw: Record<string, unknown>): EvaluationCase {
  const parsed = evaluationFileSchema.safeParse([
    { id: 'c1', question: 'Q?', authorizedCourseIds: [COURSE], ...raw },
  ]);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  const [only] = parsed.data;
  if (only === undefined) {
    throw new Error('no case');
  }
  return only;
}

async function score(
  raw: Record<string, unknown>,
  answer: RagAnswer,
  options: { secretValues?: readonly string[] } = {},
) {
  const runner = new AnswerEvaluationRunner({
    answerer: { ask: () => Promise.resolve(answer) },
    tenantId: 'tenant',
    ...(options.secretValues === undefined ? {} : { secretValues: options.secretValues }),
  });
  const report = await runner.run([parseCase(raw)]);
  const [result] = report.cases;
  if (result === undefined) {
    throw new Error('no result');
  }
  return { result, summary: report.summary };
}

const insufficient = fixtureInsufficientAnswer();

describe('fact matching is deterministic', () => {
  it('ignores case, accents composition and whitespace', () => {
    expect(normalizeForMatching('  Reapply   SUNSCREEN\n every  ')).toBe('reapply sunscreen every');
    expect(factMatches({ anyOf: ['every two hours'] }, 'Reapply  EVERY TWO   HOURS after.')).toBe(
      true,
    );
    expect(factMatches({ anyOf: ['every two hours'] }, 'Reapply every three hours.')).toBe(false);
  });

  it('accepts any listed wording', () => {
    const fact = { anyOf: ['two hours', '120 minutes'] };
    expect(factMatches(fact, 'Reapply after 120 MINUTES.')).toBe(true);
    expect(factMatches(fact, 'Reapply after a while.')).toBe(false);
  });
});

describe('AnswerEvaluationRunner scoring', () => {
  it('passes a grounded answer that meets its expectations', async () => {
    const { result, summary } = await score(
      {
        expectedResourceIds: [RESOURCE],
        requiredFacts: ['every two hours', { anyOf: ['sunscreen', 'sun cream'] }],
        forbiddenFacts: ['every three hours'],
        expectConflictingSources: false,
      },
      answerOf(),
    );
    expect(result).toMatchObject({ passed: true, failures: [] });
    expect(result.severity).toBeUndefined();
    expect(summary).toMatchObject({ passed: 1, failed: 0, criticalFailures: 0 });
  });

  it.each([
    [
      'a required fact is missing',
      { requiredFacts: ['every four hours'] },
      'missing_required_fact',
    ],
    ['a forbidden fact appears', { forbiddenFacts: ['every two hours'] }, 'forbidden_fact_present'],
    ['a conflict was expected', { expectConflictingSources: true }, 'conflict_not_reported'],
  ] as const)('fails when %s', async (_label, raw, failure) => {
    const { result } = await score(raw, answerOf());
    expect(result.failures).toContain(failure);
    expect(result.passed).toBe(false);
  });

  it('fails when a conflict is reported but not expected', async () => {
    const { result } = await score(
      { expectConflictingSources: false },
      answerOf({ conflictingSources: true }),
    );
    expect(result.failures).toContain('unexpected_conflict');
  });

  it('does not check facts or conflict on the insufficient-evidence answer', async () => {
    const { result } = await score(
      { expectInsufficientEvidence: true, forbiddenFacts: ['sunscreen'] },
      insufficient,
    );
    expect(result).toMatchObject({ passed: true, status: 'insufficient_evidence', failures: [] });
  });

  it('treats a citation that is not among the sources as a grounding failure', async () => {
    const { result } = await score({}, answerOf({ sources: [] }));
    expect(result.failures).toContain('citation_not_in_sources');
    expect(result.severity).toBe('grounding');
  });

  it('treats an answer with no valid source as a grounding failure', async () => {
    const { result, summary } = await score({}, answerOf({ citations: [], claims: [] }));
    expect(result.failures).toContain('no_valid_source');
    expect(summary.answersWithoutValidSource).toBe(1);
    expect(summary.groundingFailures).toBe(1);
  });

  it('treats a citation outside the authorised courses as critical', async () => {
    const other = answerOf();
    const { result, summary } = await score(
      {},
      answerOf({
        citations: other.citations.map((citation) => ({ ...citation, courseId: 99 })),
      }),
    );
    expect(result.failures).toContain('unauthorized_citation');
    expect(result.severity).toBe('critical');
    expect(summary.criticalFailures).toBe(1);
  });

  it('treats a forbidden resource as critical', async () => {
    const { result } = await score({ forbiddenResourceIds: [RESOURCE] }, answerOf());
    expect(result.failures).toContain('forbidden_resource_cited');
    expect(result.severity).toBe('critical');
  });

  it('treats a value that must never be shown as critical', async () => {
    const secret = 'moodle-token-abc123';
    const { result, summary } = await score({}, answerOf({ answer: `Use ${secret} to sign in.` }), {
      secretValues: [secret],
    });
    expect(result.failures).toContain('secret_in_output');
    expect(summary.criticalFailures).toBe(1);
  });

  it('checks nothing for secrets when none are given, and ignores empty strings', async () => {
    const { result } = await score({}, answerOf(), { secretValues: [''] });
    expect(result.passed).toBe(true);
  });

  it('reports an error for a case that could not be asked', async () => {
    const runner = new AnswerEvaluationRunner({
      answerer: { ask: () => Promise.reject(new Error('model down')) },
      tenantId: 'tenant',
      describeError: () => 'model_unavailable',
    });
    const report = await runner.run([parseCase({})]);
    expect(report.cases[0]).toMatchObject({
      passed: false,
      status: 'error',
      severity: 'error',
      error: 'model_unavailable',
    });
    expect(report.summary.errors).toBe(1);
  });

  it('reports the worst severity when a case fails several rules', async () => {
    const { result } = await score(
      { forbiddenResourceIds: [RESOURCE], requiredFacts: ['never written'] },
      answerOf(),
    );
    expect(result.failures).toEqual(
      expect.arrayContaining(['forbidden_resource_cited', 'missing_required_fact']),
    );
    expect(result.severity).toBe('critical');
  });

  it('classifies every failure, and orders severities', () => {
    const failures = Object.keys(FAILURE_SEVERITY) as AnswerCaseFailure[];
    for (const failure of failures) {
      expect(['critical', 'grounding', 'expectation', 'error']).toContain(
        FAILURE_SEVERITY[failure],
      );
    }
    expect(worstSeverity([])).toBeUndefined();
    expect(worstSeverity(['missing_required_fact', 'no_valid_source'])).toBe('grounding');
    expect(worstSeverity(['error', 'unauthorized_citation'])).toBe('critical');
    expect(worstSeverity(['missing_required_fact', 'error'])).toBe('error');
  });
});

describe('case file validation', () => {
  it.each([
    [
      'a required fact that is also forbidden',
      { requiredFacts: ['two hours'], forbiddenFacts: [{ anyOf: ['TWO  HOURS'] }] },
    ],
    [
      'required facts on an insufficient-evidence case',
      { expectInsufficientEvidence: true, requiredFacts: ['two hours'] },
    ],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseCase(raw)).toThrow();
  });

  it('accepts a case with no facts at all', () => {
    expect(parseCase({})).toMatchObject({ requiredFacts: [], forbiddenFacts: [] });
  });
});
