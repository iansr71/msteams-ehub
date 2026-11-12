import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/*
 * Evaluation dataset schemas (docs/acceptance.md). Retrieval and answer cases share the schema
 * the CLI already uses (apps/api/src/retrieval/evaluationCases.ts); the three kinds here drive
 * the acceptance suites, which run against fakes rather than a deployed environment.
 *
 * Every expectation is a fixed value, an ID or a phrase: scoring never asks a model whether an
 * answer was good.
 */

const id = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, {
  message: 'must be 1-64 letters, digits, ".", "_" or "-".',
});
const phrase = z.string().trim().min(2).max(300);
const courseId = z.number().int().positive().max(2_147_483_647);
const notes = z.string().max(1000).optional();

/** The twelve attacks Prompt 17 requires, as used by the security report. */
export const ATTACK_KINDS = [
  'user prompt injection',
  'PDF prompt injection',
  'hidden HTML instructions',
  'forged course ID',
  'forged identity fields',
  'unauthorized resource URL',
  'SSRF URL',
  'oversized question',
  'script output',
  'malicious citation',
  'token leakage through exceptions',
  'admin-role bypass',
] as const;

/**
 * A hostile input and what must not happen. `surface` says where it enters the system, which
 * decides which suite runs it.
 */
export const securityCaseSchema = z
  .strictObject({
    id,
    attack: z.enum(ATTACK_KINDS),
    surface: z.enum(['question', 'document', 'api', 'admin']),
    /** The hostile text, URL or body. Never a real credential. */
    payload: z.string().min(1).max(20_000),
    /** The answer must be the insufficient-evidence reply (nothing was supported). */
    expectRefused: z.boolean().default(false),
    /** None of these may appear in the answer, a citation, a card or a log line. */
    mustNotAppear: z.array(phrase).max(50).default([]),
    /** Resource IDs that must not be cited. */
    mustNotCite: z.array(z.string().trim().min(1).max(1100)).max(50).default([]),
    /** For `api` and `admin` cases: the status the request must get. */
    expectStatus: z.number().int().min(100).max(599).optional(),
    notes,
  })
  .superRefine((testCase, ctx) => {
    if (testCase.expectStatus !== undefined && !['api', 'admin'].includes(testCase.surface)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectStatus'],
        message: 'applies only to api and admin cases.',
      });
    }
    if (testCase.expectRefused && testCase.surface === 'api') {
      ctx.addIssue({
        code: 'custom',
        path: ['expectRefused'],
        message: 'applies to question and document cases; use expectStatus for api cases.',
      });
    }
  });
export type SecurityCase = z.output<typeof securityCaseSchema>;

/** What one user may read, and what the system must do when they ask. */
export const authorizationCaseSchema = z
  .strictObject({
    id,
    /** Entra object ID of the signed-in user (a fake GUID in the dataset). */
    objectId: z.uuid(),
    /** The email on the token; used for matching to a Moodle account. */
    email: z.email().optional(),
    /** Courses this user is actively enrolled in, in Moodle. */
    enrolledCourseIds: z.array(courseId).max(1000).default([]),
    /** Courses the request asks about; omitted means "everything authorised". */
    requestedCourseIds: z.array(courseId).max(1000).optional(),
    /** Whether the user exists in Moodle at all (false tests the unmapped path). */
    existsInMoodle: z.boolean().default(true),
    /** Moodle cannot be reached: the request must fail closed. */
    moodleUnavailable: z.boolean().default(false),
    outcome: z.enum([
      'answered',
      'no_authorized_courses',
      'course_not_authorized',
      'identity_not_mapped',
      'authorization_unavailable',
    ]),
    /** Content from these courses must never be retrieved or cited. */
    forbiddenCourseIds: z.array(courseId).max(1000).default([]),
    notes,
  })
  .superRefine((testCase, ctx) => {
    if (testCase.outcome === 'answered' && testCase.enrolledCourseIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'cannot be "answered" for a user with no enrolments.',
      });
    }
    const enrolled = new Set(testCase.enrolledCourseIds);
    testCase.forbiddenCourseIds.forEach((course, index) => {
      if (enrolled.has(course)) {
        ctx.addIssue({
          code: 'custom',
          path: ['forbiddenCourseIds', index],
          message: 'is also an enrolment, so it is allowed.',
        });
      }
    });
  });
export type AuthorizationCase = z.output<typeof authorizationCaseSchema>;

/**
 * A document that changes, and what the answer must say before and after. `beforeFacts` must
 * disappear and `afterFacts` must appear: that is the whole point of the re-sync.
 */
export const contentUpdateCaseSchema = z
  .strictObject({
    id,
    courseId,
    /** Moodle activity (module) ID of the page that changes. */
    moduleId: courseId,
    question: z.string().trim().min(1).max(1000),
    /** Paragraphs of the page before and after the change. */
    before: z.array(phrase.max(2000)).min(1).max(50),
    after: z.array(phrase.max(2000)).min(1).max(50),
    /** Phrases that must be answered before the change and gone afterwards. */
    beforeFacts: z.array(phrase).min(1).max(20),
    /** Phrases that must be absent before the change and answered afterwards. */
    afterFacts: z.array(phrase).min(1).max(20),
    notes,
  })
  .superRefine((testCase, ctx) => {
    const after = testCase.after.join(' ').toLowerCase();
    const before = testCase.before.join(' ').toLowerCase();
    testCase.beforeFacts.forEach((fact, index) => {
      if (!before.includes(fact.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['beforeFacts', index],
          message: 'does not appear in "before", so it could never be answered.',
        });
      }
      if (after.includes(fact.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['beforeFacts', index],
          message: 'still appears in "after", so its disappearance cannot be proved.',
        });
      }
    });
    testCase.afterFacts.forEach((fact, index) => {
      if (!after.includes(fact.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['afterFacts', index],
          message: 'does not appear in "after".',
        });
      }
      if (before.includes(fact.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['afterFacts', index],
          message: 'already appears in "before".',
        });
      }
    });
  });
export type ContentUpdateCase = z.output<typeof contentUpdateCaseSchema>;

function fileSchema<Schema extends z.ZodType>(caseSchema: Schema) {
  return z
    .array(caseSchema)
    .min(1, { message: 'the file contains no cases.' })
    .max(2000)
    .superRefine((cases, ctx) => {
      const seen = new Set<string>();
      for (const [index, testCase] of cases.entries()) {
        const caseId = (testCase as { id: string }).id;
        if (seen.has(caseId)) {
          ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'is used more than once.' });
        }
        seen.add(caseId);
      }
    });
}

export const securityCaseFileSchema = fileSchema(securityCaseSchema);
export const authorizationCaseFileSchema = fileSchema(authorizationCaseSchema);
export const contentUpdateCaseFileSchema = fileSchema(contentUpdateCaseSchema);

export class DatasetError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[]) {
    super([message, ...problems].join('\n'));
    this.name = 'DatasetError';
    this.problems = problems;
  }
}

export const DATASET_DIRECTORY = fileURLToPath(new URL('../../evaluation/', import.meta.url));

/** Reads and validates a dataset from tests/evaluation. Problems name fields, never values. */
export function loadDataset<Schema extends z.ZodType>(
  fileName: string,
  schema: Schema,
): z.output<Schema> {
  const path = join(DATASET_DIRECTORY, fileName);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new DatasetError(`${fileName} is missing or not valid JSON.`, []);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new DatasetError(
      `${fileName} is invalid.`,
      parsed.error.issues
        .slice(0, 20)
        .map(
          (issue) =>
            `${issue.path.length === 0 ? '(file)' : issue.path.join('.')}: ${issue.message}`,
        ),
    );
  }
  return parsed.data;
}
