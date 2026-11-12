import { SEARCH_RESOURCE_TYPES } from '@ehub/shared/search';
import { z } from 'zod';

/*
 * Evaluation file format: a JSON array of cases. Course IDs may be written as strings ("123")
 * or numbers. An expected or forbidden resource ID matches a retrieved chunk when it equals
 * the chunk's resource ID (e.g. "701:chapter:11") or its Moodle activity ID (e.g. "701").
 */

const courseId = z
  .union([
    z.string().regex(/^[1-9]\d{0,9}$/, { message: 'must be a positive whole number.' }),
    z.number(),
  ])
  .transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647));

const resourceId = z.string().trim().min(1).max(1100);

const phrase = z.string().trim().min(2).max(300);

/**
 * A fact to look for in an answer: one phrase, or `{ "anyOf": [...] }` for alternative
 * wordings. Normalised to the `anyOf` form so scoring has one shape to handle.
 */
const factMatcher = z
  .union([phrase, z.strictObject({ anyOf: z.array(phrase).min(1).max(10) })])
  .transform((value) => (typeof value === 'string' ? { anyOf: [value] } : value));

export type FactMatcher = z.output<typeof factMatcher>;

/** NFC, lower case, collapsed whitespace: enough to survive reformatting, nothing cleverer. */
export function normalizeForMatching(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when any of the matcher's phrasings appears in `text`. Deterministic, no model. */
export function factMatches(matcher: FactMatcher, text: string): boolean {
  const haystack = normalizeForMatching(text);
  return matcher.anyOf.some((candidate) => haystack.includes(normalizeForMatching(candidate)));
}

export const evaluationCaseSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, {
      message: 'must be 1-64 letters, digits, ".", "_" or "-".',
    }),
    question: z.string().trim().min(1).max(1000),
    /** The courses the simulated user may read; the search is restricted to these. */
    authorizedCourseIds: z.array(courseId).min(1).max(1000),
    /** At least one result must come from one of these courses (when given). */
    expectedCourseIds: z.array(courseId).max(1000).default([]),
    /** At least one of these must be retrieved for the case to pass (when given). */
    expectedResourceIds: z.array(resourceId).max(100).default([]),
    /** None of these may be retrieved. */
    forbiddenResourceIds: z.array(resourceId).max(100).default([]),
    /** Optional narrowing within the authorised courses, as a user's course picker would. */
    courseIds: z.array(courseId).min(1).max(1000).optional(),
    resourceTypes: z.array(z.enum(SEARCH_RESOURCE_TYPES)).min(1).optional(),
    /** Answer evaluation: the case passes only if the answer is the insufficient-evidence response. */
    expectInsufficientEvidence: z.boolean().default(false),
    /**
     * Answer evaluation: phrases that must appear in the answer, and phrases that must not.
     * Matching is deterministic (see `factMatches`): no model judges correctness. Give
     * alternatives with `{ "anyOf": [...] }` when the wording may differ.
     */
    requiredFacts: z.array(factMatcher).max(50).default([]),
    forbiddenFacts: z.array(factMatcher).max(50).default([]),
    /**
     * Answer evaluation: whether the answer must report disagreeing passages. `true` requires
     * it, `false` requires its absence, omitted does not check.
     */
    expectConflictingSources: z.boolean().optional(),
    /** Free text for the people maintaining the file; never used in scoring. */
    notes: z.string().max(1000).optional(),
  })
  .superRefine((testCase, ctx) => {
    const authorized = new Set(testCase.authorizedCourseIds);
    testCase.expectedCourseIds.forEach((id, index) => {
      if (!authorized.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedCourseIds', index],
          message: 'is not in authorizedCourseIds, so it can never be retrieved.',
        });
      }
    });
    testCase.courseIds?.forEach((id, index) => {
      if (!authorized.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['courseIds', index],
          message: 'is not in authorizedCourseIds.',
        });
      }
    });
    if (testCase.expectInsufficientEvidence && testCase.requiredFacts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['requiredFacts'],
        message:
          'cannot be checked when expectInsufficientEvidence is true: that answer is a fixed message.',
      });
    }
    const requiredPhrases = new Set(
      testCase.requiredFacts.flatMap((fact) => fact.anyOf.map(normalizeForMatching)),
    );
    testCase.forbiddenFacts.forEach((fact, index) => {
      if (fact.anyOf.some((candidate) => requiredPhrases.has(normalizeForMatching(candidate)))) {
        ctx.addIssue({
          code: 'custom',
          path: ['forbiddenFacts', index],
          message: 'is also listed as required, so the case can never pass.',
        });
      }
    });
    const forbidden = new Set(testCase.forbiddenResourceIds);
    testCase.expectedResourceIds.forEach((id, index) => {
      if (forbidden.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedResourceIds', index],
          message: 'is also listed as forbidden.',
        });
      }
    });
  });
export type EvaluationCase = z.output<typeof evaluationCaseSchema>;

export const evaluationFileSchema = z
  .array(evaluationCaseSchema)
  .min(1, { message: 'the file contains no cases.' })
  .max(2000)
  .superRefine((cases, ctx) => {
    const seen = new Set<string>();
    cases.forEach((testCase, index) => {
      if (seen.has(testCase.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'is used more than once.' });
      }
      seen.add(testCase.id);
    });
  });

export const MAX_EVALUATION_FILE_BYTES = 5 * 1024 * 1024;

export class EvaluationFileError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(message);
    this.name = 'EvaluationFileError';
    this.problems = problems;
  }
}

/** Parses and validates file text. Problems name the case index and field, not values. */
export function parseEvaluationFile(text: string): EvaluationCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EvaluationFileError('The evaluation file is not valid JSON.');
  }
  const parsed = evaluationFileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 20)
      .map(
        (issue) => `${issue.path.length === 0 ? '(file)' : issue.path.join('.')}: ${issue.message}`,
      );
    throw new EvaluationFileError('The evaluation file is invalid.', problems);
  }
  return parsed.data;
}
