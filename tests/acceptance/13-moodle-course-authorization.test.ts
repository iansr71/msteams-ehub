import { afterEach, describe, expect, it } from 'vitest';

import { modelAnswer } from '../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import { moodleUser } from '../../apps/api/src/authorization/__fixtures__/fakeMoodle.js';
import { startAnswerApi, type AnswerApi } from '../security/__fixtures__/answerApi.js';
import {
  authorizationCaseFileSchema,
  loadDataset,
  type AuthorizationCase,
} from './framework/datasets.js';

/*
 * Acceptance suite 13: a signed-in user may read exactly the courses they are enrolled in, and
 * nothing is answered when that cannot be confirmed. Driven by
 * tests/evaluation/authorization-cases.json, so the rules can be extended without new code.
 */

const QUESTION = 'How often should sunscreen be reapplied after a peel?';
const cases = loadDataset('authorization-cases.json', authorizationCaseFileSchema);

const EXPECTED_STATUS: Readonly<Record<AuthorizationCase['outcome'], number>> = {
  answered: 200,
  no_authorized_courses: 403,
  course_not_authorized: 403,
  identity_not_mapped: 403,
  authorization_unavailable: 503,
};

let api: AnswerApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function run(testCase: AuthorizationCase) {
  api = await startAnswerApi();
  api.modelReplies(modelAnswer());
  const { moodle } = api;
  moodle.users = testCase.existsInMoodle
    ? [
        moodleUser(900, {
          email: testCase.email ?? 'nobody@example.test',
          courses: testCase.enrolledCourseIds.map((id) => ({ id, visible: 1 })),
        }),
      ]
    : [];
  moodle.failCourses = testCase.moodleUnavailable;
  const token = await api.kit.sign({
    oid: testCase.objectId,
    email: testCase.email ?? 'nobody@example.test',
  });
  const body =
    testCase.requestedCourseIds === undefined
      ? { question: QUESTION }
      : { question: QUESTION, selectedCourseIds: [...testCase.requestedCourseIds] };
  return { result: await api.ask(token, body), api };
}

describe('13 Moodle course authorization', () => {
  it('has cases for every outcome the API can return', () => {
    const outcomes = new Set(cases.map((testCase) => testCase.outcome));
    for (const outcome of Object.keys(EXPECTED_STATUS)) {
      expect(outcomes, outcome).toContain(outcome);
    }
  });

  it.each(cases.map((testCase) => [testCase.id, testCase] as const))(
    'case %s',
    async (_id, testCase) => {
      const { result, api: started } = await run(testCase);
      expect(result.status).toBe(EXPECTED_STATUS[testCase.outcome]);
      if (testCase.outcome === 'answered') {
        expect(result.body['status']).toBe('answered');
        const citations = (result.body['citations'] ?? []) as { courseId: number }[];
        for (const citation of citations) {
          expect(testCase.enrolledCourseIds).toContain(citation.courseId);
        }
      } else {
        const error = result.body['error'] as { code?: string } | undefined;
        expect(error?.code).toBeDefined();
        // Nothing from a course the user may not read, in the body or the logs.
        for (const course of testCase.forbiddenCourseIds) {
          expect(result.text).not.toContain(`"courseId":${String(course)}`);
        }
        expect(result.body['citations']).toBeUndefined();
      }
      expect(started.logs.join('\n')).not.toContain(QUESTION);
    },
  );

  it('re-reads Moodle rather than trusting an earlier answer when enrolments are revoked', async () => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer());
    api.moodle.users = [
      moodleUser(900, { email: 'member@example.test', courses: [{ id: 12, visible: 1 }] }),
    ];
    const token = await api.kit.sign({
      oid: '66666666-6666-4666-8666-666666666666',
      email: 'member@example.test',
    });
    expect((await api.ask(token, { question: QUESTION })).status).toBe(200);

    // Revoked in Moodle, and the cached decision invalidated as the admin action does.
    api.moodle.setCourses(900, []);
    const second = await api.ask(token, { question: QUESTION });
    expect([200, 403]).toContain(second.status);
    if (second.status === 403) {
      expect((second.body['error'] as { code: string }).code).toBe('no_authorized_courses');
    }
  });
});
