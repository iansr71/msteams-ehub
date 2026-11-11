import { request as httpRequest } from 'node:http';

import { MOCK_IDENTITY_HEADER } from '@ehub/shared/answers';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OTHER_TENANT,
  unsignedToken,
  withForgedPayload,
} from '../../../apps/api/src/auth/__fixtures__/tokens.js';
import { MAX_BODY_BYTES } from '../../../apps/api/src/http/apiServer.js';
import {
  ConcurrencyLimiter,
  SlidingWindowRateLimiter,
} from '../../../apps/api/src/http/requestLimits.js';
import { modelAnswer } from '../../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import { USER_A, USER_B, startAnswerApi, type AnswerApi } from '../__fixtures__/answerApi.js';

/*
 * Attack tests: forged course IDs, forged identity fields and oversized or malformed input,
 * sent to the real answer API with real (locally signed) Entra tokens.
 */

const QUESTION = 'How often should sunscreen be reapplied after a peel?';
const LASER_QUESTION = 'What eye protection do laser treatments require?';

let api: AnswerApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

function everythingTheModelSaw(target: AnswerApi): string {
  return JSON.stringify(target.modelRequests.map((request) => request.messages));
}

describe('attack: forged course ID', () => {
  it('refuses a course the user is not enrolled in before any search or model call', async () => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer());
    const result = await api.ask(await api.tokenFor(USER_A), {
      question: LASER_QUESTION,
      selectedCourseIds: [13],
    });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'course_not_authorized' } });
    expect(api.modelRequests).toHaveLength(0);
    expect(result.text).not.toContain('goggles');
  });

  it('refuses a mix of an enrolled and a forged course rather than answering from the allowed one', async () => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer());
    const result = await api.ask(await api.tokenFor(USER_A), {
      question: LASER_QUESTION,
      selectedCourseIds: [12, 13],
    });
    expect(result.status).toBe(403);
    expect(api.modelRequests).toHaveLength(0);
  });

  it('never shows the model another course’s content when no course is selected', async () => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer());
    await api.ask(await api.tokenFor(USER_A), { question: LASER_QUESTION });
    const seen = everythingTheModelSaw(api);
    expect(seen).toContain('Laser treatments are offered at selected branches'); // course 12
    expect(seen).not.toContain('goggles'); // course 13
    expect(seen).not.toContain('Laser Safety');
  });

  it.each([
    ['a string', { selectedCourseIds: ['13'] }],
    ['a negative ID', { selectedCourseIds: [-13] }],
    ['a filter expression', { selectedCourseIds: ['12 or courseId eq 13'] }],
    ['a fraction', { selectedCourseIds: [12.5] }],
    ['an object', { selectedCourseIds: { $ne: null } }],
  ])('rejects %s as a course ID', async (_label, extra) => {
    api = await startAnswerApi();
    const result = await api.ask(await api.tokenFor(USER_A), { question: QUESTION, ...extra });
    expect(result.status).toBe(400);
    expect(api.modelRequests).toHaveLength(0);
  });
});

describe('attack: forged identity fields', () => {
  it.each([
    ['userId', { userId: USER_B.oid }],
    ['user', { user: { userId: USER_B.oid, authorizedCourseIds: [13] } }],
    ['authorizedCourseIds', { authorizedCourseIds: [13] }],
    ['tenantId', { tenantId: OTHER_TENANT }],
    ['roles', { roles: ['EHub.ApplicationAdministrator'] }],
    ['__proto__', JSON.parse('{"__proto__": {"authorizedCourseIds": [13]}}') as object],
  ])('rejects a body that states %s', async (_label, extra) => {
    api = await startAnswerApi();
    const result = await api.ask(await api.tokenFor(USER_A), {
      question: LASER_QUESTION,
      ...extra,
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'invalid_request' } });
    expect(api.modelRequests).toHaveLength(0);
  });

  it('ignores identity headers: the validated token decides who is asking', async () => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer());
    const result = await api.ask(
      await api.tokenFor(USER_A),
      { question: LASER_QUESTION },
      {
        [MOCK_IDENTITY_HEADER]: USER_B.oid,
        'x-user-id': USER_B.oid,
        'x-ms-client-principal-id': USER_B.oid,
        'x-ms-client-principal-name': USER_B.email,
        'x-forwarded-user': USER_B.email,
        'x-authorized-course-ids': '13',
      },
    );
    // Either refused, or answered strictly as user A: never with user B's course.
    expect([200, 401]).toContain(result.status);
    expect(everythingTheModelSaw(api)).not.toContain('goggles');
  });

  it('rejects a token whose payload was edited to name another user', async () => {
    api = await startAnswerApi();
    const forged = withForgedPayload(await api.tokenFor(USER_A), {
      oid: USER_B.oid,
      email: USER_B.email,
    });
    const result = await api.ask(forged, { question: LASER_QUESTION });
    expect(result.status).toBe(401);
    expect(api.modelRequests).toHaveLength(0);
  });

  it('rejects an unsigned token and a token from another tenant', async () => {
    api = await startAnswerApi();
    const unsigned = await api.ask(unsignedToken({ oid: USER_B.oid }), { question: QUESTION });
    expect(unsigned.status).toBe(401);
    const foreign = await api.ask(await api.tokenFor(USER_A, { tid: OTHER_TENANT }), {
      question: QUESTION,
    });
    expect([401, 403]).toContain(foreign.status);
    expect(api.modelRequests).toHaveLength(0);
  });

  it('does not let a token’s own "roles" or "courses" claims grant course access', async () => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer());
    const token = await api.tokenFor(USER_A, {
      roles: ['EHub.ApplicationAdministrator'],
      courses: [13],
      authorizedCourseIds: [13],
    });
    const result = await api.ask(token, { question: LASER_QUESTION, selectedCourseIds: [13] });
    expect(result.status).toBe(403);
  });

  it('refuses an unknown user rather than guessing an identity', async () => {
    api = await startAnswerApi();
    const stranger = { oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'x@nowhere.example' };
    const result = await api.ask(await api.tokenFor(stranger), { question: QUESTION });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'identity_not_mapped' } });
    expect(api.modelRequests).toHaveLength(0);
  });
});

describe('attack: oversized and malformed input', () => {
  it('refuses a body over the size limit without parsing it', async () => {
    api = await startAnswerApi();
    const result = await api.ask(await api.tokenFor(USER_A), {
      question: 'a'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ error: { code: 'payload_too_large' } });
    expect(api.modelRequests).toHaveLength(0);
  });

  it('refuses a streamed body that exceeds the limit without declaring its length', async () => {
    api = await startAnswerApi();
    const token = await api.tokenFor(USER_A);
    const target = new URL(`${api.url}/v1/answers`);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.write('{"question":"');
      for (let i = 0; i < 40; i += 1) {
        request.write('x'.repeat(1024));
      }
      request.end('"}');
    });
    expect(status).toBe(413);
    expect(api.modelRequests).toHaveLength(0);
  });

  it('refuses a question over the character limit', async () => {
    api = await startAnswerApi({ maxQuestionChars: 200 });
    const result = await api.ask(await api.tokenFor(USER_A), { question: 'peel '.repeat(60) });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'invalid_question' } });
    expect(api.modelRequests).toHaveLength(0);
  });

  it.each([
    ['form encoding', 'application/x-www-form-urlencoded', 'question=hello'],
    ['plain text', 'text/plain', '{"question":"hello"}'],
    ['multipart', 'multipart/form-data; boundary=x', '--x--'],
    ['XML', 'application/xml', '<question>hello</question>'],
  ])('refuses %s', async (_label, contentType, body) => {
    api = await startAnswerApi();
    const result = await api.ask(await api.tokenFor(USER_A), body, {
      'content-type': contentType,
    });
    expect(result.status).toBe(415);
  });

  it.each([
    ['malformed JSON', '{"question": '],
    ['an array', '[{"question":"x"}]'],
    ['a number for the question', '{"question": 42}'],
    ['an empty question', '{"question": "   "}'],
    ['null', 'null'],
  ])('refuses %s with 400 and no detail about the parser', async (_label, body) => {
    api = await startAnswerApi();
    const result = await api.ask(await api.tokenFor(USER_A), body);
    expect(result.status).toBe(400);
    expect(result.text).not.toMatch(/SyntaxError|Unexpected token|position \d+|at JSON|zod/i);
    expect(api.modelRequests).toHaveLength(0);
  });

  it('normalises Unicode and removes control and direction-override characters', async () => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer());
    // A decomposed e-acute, a right-to-left override, a NUL and direction isolates.
    const c = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
    const question = `Cafe${c(0x301)} peel ${c(0x202e)}evil${c(0x202c)} sun${c(0)}screen reapplied${c(0x2066)}?${c(0x2069)}`;
    const result = await api.ask(await api.tokenFor(USER_A), { question });
    expect(result.status).toBe(200);
    const seen = api.modelRequests.at(-1)?.messages[1]?.content ?? '';
    expect(seen).toContain(`Caf${c(0xe9)}`); // composed by NFC
    const unsafe = Array.from(seen).filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code <= 0x08 ||
        (code >= 0x0b && code <= 0x1f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    });
    expect(unsafe).toEqual([]);
  });
});

describe('attack: flooding', () => {
  it('limits each user separately and tells the caller when to retry', async () => {
    api = await startAnswerApi({
      limits: {
        questions: new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000 }),
        feedback: new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000 }),
        concurrency: new ConcurrencyLimiter(4),
      },
    });
    api.modelReplies(modelAnswer());
    const a = await api.tokenFor(USER_A);
    expect((await api.ask(a, { question: QUESTION })).status).toBe(200);
    expect((await api.ask(a, { question: QUESTION })).status).toBe(200);
    const refused = await api.ask(a, { question: QUESTION });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // A second token for the same user does not reset the limit; another user is unaffected.
    expect((await api.ask(await api.tokenFor(USER_A), { question: QUESTION })).status).toBe(429);
    const b = await api.ask(await api.tokenFor(USER_B), { question: LASER_QUESTION });
    expect(b.status).not.toBe(429);
    expect(api.modelRequests).toHaveLength(3);
  });

  it('does not let invalid tokens use up a real user’s allowance', async () => {
    api = await startAnswerApi({
      limits: {
        questions: new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 }),
        feedback: new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 }),
        concurrency: new ConcurrencyLimiter(4),
      },
    });
    api.modelReplies(modelAnswer());
    const forged = withForgedPayload(await api.tokenFor(USER_A), { name: 'x' });
    for (let i = 0; i < 5; i += 1) {
      expect((await api.ask(forged, { question: QUESTION })).status).toBe(401);
    }
    expect((await api.ask(await api.tokenFor(USER_A), { question: QUESTION })).status).toBe(200);
  });
});
