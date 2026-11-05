import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type CommandContext } from '@ehub/shared';
import { createEmbeddingProvider } from '@ehub/shared/embeddings';
import { afterEach, describe, expect, it } from 'vitest';

import {
  API_CLIENT_ID,
  BOT_CLIENT_ID,
  TENANT as TOKEN_TENANT,
  createTokenKit,
} from '../../apps/api/src/auth/__fixtures__/tokens.js';
import { createApiCommands } from '../../apps/api/src/commands/index.js';
import { createAuthorizationCommands } from '../../apps/api/src/commands/authorizationCommands.js';
import {
  ScriptedChatModel,
  modelAnswer,
} from '../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import {
  API_KEY,
  TENANT_ID,
  TEST_DIMENSIONS,
  seededSearch,
} from '../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { FakeEmbeddingService } from '../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';

/*
 * `pnpm api serve` in production mode, in-process: real Entra token validation, the real
 * Moodle REST client (over a fake HTTP transport that speaks Moodle's web-service protocol),
 * the file identity store, and the RAG engine over the fake search service.
 */

const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';
const MOODLE_TOKEN = 'moodle-integration-token-0123456789abcdef';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface MoodleCall {
  readonly wsfunction: string;
  readonly form: URLSearchParams;
}

/** Moodle's REST protocol: form-encoded POST to server.php, JSON (or an exception) back. */
function fakeMoodle() {
  const calls: MoodleCall[] = [];
  const state = {
    courses: new Map<number, { id: number; visible: number }[]>([
      [
        501,
        [
          { id: 12, visible: 1 },
          { id: 99, visible: 0 },
        ],
      ],
    ]),
    down: false,
  };
  const users = [
    {
      id: 501,
      username: 'thandi',
      fullname: 'Thandi Test',
      email: 'Thandi@SkinRenewal.example',
      suspended: false,
    },
  ];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    const wsfunction = form.get('wsfunction') ?? '';
    calls.push({ wsfunction, form });
    if (!url.endsWith('/webservice/rest/server.php') || form.get('wstoken') !== MOODLE_TOKEN) {
      return Promise.resolve(
        Response.json({
          exception: 'moodle_exception',
          errorcode: 'invalidtoken',
          message: 'Invalid token',
        }),
      );
    }
    if (state.down) {
      return Promise.resolve(new Response('Service unavailable', { status: 503 }));
    }
    if (wsfunction === 'core_user_get_users_by_field') {
      const values = [...form.entries()]
        .filter(([key]) => key.startsWith('values['))
        .map(([, value]) => value);
      const field = form.get('field');
      // Case-sensitive, as on PostgreSQL.
      const found = users.filter((user) =>
        field === 'email'
          ? values.includes(user.email)
          : field === 'id'
            ? values.includes(String(user.id))
            : false,
      );
      return Promise.resolve(Response.json(found));
    }
    if (wsfunction === 'core_enrol_get_users_courses') {
      const userId = Number(form.get('userid'));
      return Promise.resolve(
        Response.json(
          (state.courses.get(userId) ?? []).map((course) => ({
            id: course.id,
            shortname: `C${String(course.id)}`,
            fullname: `Course ${String(course.id)}`,
            visible: course.visible,
          })),
        ),
      );
    }
    return Promise.resolve(
      Response.json({
        exception: 'moodle_exception',
        errorcode: 'accessexception',
        message: 'Access control exception',
      }),
    );
  };
  return { fetch, calls, state };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
  return port;
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('pnpm api serve with Moodle course authorisation', () => {
  it('maps the signed-in user through Moodle and searches only their enrolled courses', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ehub-authz-'));
    directories.push(stateDir);
    const kit = await createTokenKit();
    const now = Math.floor(Date.now() / 1000);
    const token = (oid: string, email: string) =>
      kit.sign({ oid, email, iat: now - 60, nbf: now - 60, exp: now + 3600 });
    const moodle = fakeMoodle();
    const { client, service: search } = await seededSearch();
    const embeddings = new FakeEmbeddingService({
      apiKey: OPENAI_KEY,
      dimensions: TEST_DIMENSIONS,
    });
    const env = {
      NODE_ENV: 'production',
      PORT: String(await freePort()),
      AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
      AZURE_SEARCH_API_KEY: API_KEY,
      AZURE_SEARCH_VECTOR_DIMENSIONS: String(TEST_DIMENSIONS),
      AZURE_TENANT_ID: TENANT_ID,
      AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
      AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
      AZURE_OPENAI_API_KEY: OPENAI_KEY,
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
      AZURE_OPENAI_EMBEDDING_DIMENSIONS: String(TEST_DIMENSIONS),
      MOODLE_BASE_URL: 'https://ehub.example.test',
      MOODLE_TOKEN,
      MOODLE_MAX_RETRIES: '0',
      ENTRA_API_CLIENT_ID: API_CLIENT_ID,
      ENTRA_ALLOWED_CLIENT_APP_IDS: BOT_CLIENT_ID,
      ENTRA_ALLOWED_TENANT_IDS: `${TOKEN_TENANT},${TENANT_ID}`,
      IDENTITY_STATE_DIR: stateDir,
      AZURE_SEARCH_MAX_RETRIES: '0',
      EMBEDDING_MAX_RETRIES: '0',
    };
    const logs: string[] = [];
    const output: string[] = [];
    const context: CommandContext = {
      args: [],
      logger: createLogger({
        service: 'test',
        level: 'trace',
        sink: { write: (line) => logs.push(line) },
      }),
      stdout: (text) => output.push(text),
    };
    const results: Record<string, { status: number; body: Record<string, unknown> }> = {};
    const ask = async (url: string, bearer: string, body: Record<string, unknown>) => {
      const response = await fetch(`${url}/v1/answers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const serve = createApiCommands({
      env,
      serve: {
        env,
        createSearch: () => Promise.resolve(client),
        createChat: () =>
          Promise.resolve(new ScriptedChatModel(Array.from({ length: 5 }, () => modelAnswer()))),
        createEmbedder: (settings) =>
          createEmbeddingProvider(settings, { fetch: embeddings.fetch }),
        signingKeys: kit.keys,
        moodleFetch: moodle.fetch,
        waitForShutdown: async (server) => {
          const question = { question: 'How often should sunscreen be reapplied after a peel?' };
          results['userA'] = await ask(
            server.url,
            await token(USER_A, 'Thandi@SkinRenewal.example'),
            question,
          );
          results['selectB'] = await ask(
            server.url,
            await token(USER_A, 'Thandi@SkinRenewal.example'),
            {
              ...question,
              selectedCourseIds: [13],
            },
          );
          results['unmapped'] = await ask(
            server.url,
            await token(USER_B, 'nobody@SkinRenewal.example'),
            question,
          );
          moodle.state.down = true;
          // A different user: user B's denial is cached for up to a minute.
          results['outage'] = await ask(
            server.url,
            await token(USER_C, 'other@SkinRenewal.example'),
            question,
          );
        },
      },
    })['serve'];
    const serveExit = await serve?.run(context);
    if (serveExit !== 0) {
      throw new Error(output.join('\n'));
    }
    expect(output.join('\n')).toContain('Course access: Moodle enrolments');

    // User A: mapped by email (as issued, case-sensitive store), enrolled in course 12 only;
    // hidden course 99 is left out of the filter.
    expect(results['userA']?.status).toBe(200);
    const filters = search.requests
      .filter((request) => request.path.endsWith('/docs/search'))
      .map((request) => (JSON.parse(request.body) as { filter: string }).filter);
    expect(filters).toHaveLength(1);
    expect(filters[0]).toContain('(courseId eq 12)');
    expect(filters[0]).not.toContain('99');
    expect(moodle.calls.map((call) => call.wsfunction).slice(0, 2)).toEqual([
      'core_user_get_users_by_field',
      'core_enrol_get_users_courses',
    ]);

    // A selected course outside the set, an unmapped user and an outage are refused before search.
    expect(results['selectB']).toMatchObject({
      status: 403,
      body: { error: { code: 'course_not_authorized' } },
    });
    expect(results['unmapped']).toMatchObject({
      status: 403,
      body: { error: { code: 'identity_not_mapped' } },
    });
    expect(results['outage']).toMatchObject({
      status: 503,
      body: { error: { code: 'authorization_unavailable' } },
    });

    // The audit trail and observations are in the file store, readable by the admin commands.
    const stored = JSON.parse(readFileSync(join(stateDir, 'identity-state.json'), 'utf8')) as {
      failures: { objectId: string; reason: string }[];
    };
    expect(stored.failures).toEqual([
      expect.objectContaining({ objectId: USER_B, reason: 'no_match' }),
    ]);
    moodle.state.down = false;
    const commandOutput: string[] = [];
    const courses = createAuthorizationCommands({ env, moodleFetch: moodle.fetch })['courses'];
    expect(
      await courses?.run({
        args: ['--entra-object-id', USER_A, '--tenant-id', TOKEN_TENANT],
        logger: context.logger,
        stdout: (text) => commandOutput.push(text),
      }),
    ).toBe(0);
    expect(JSON.parse(commandOutput.join(''))).toMatchObject({
      result: 'authorized',
      method: 'email',
      moodleUserId: 501,
      courseIds: [12],
      claimsUsed: { source: 'last-sign-in', email: 't…@skinrenewal.example' },
    });

    const logText = logs.join('\n');
    expect(logText).not.toContain(MOODLE_TOKEN);
    expect(logText).not.toContain('Thandi@SkinRenewal');
    expect(logText).not.toContain('nobody@');
  });

  it('refuses to start in production without Moodle authorisation', async () => {
    const output: string[] = [];
    const exitCode = await createApiCommands({
      env: {
        NODE_ENV: 'production',
        ENTRA_API_CLIENT_ID: API_CLIENT_ID,
        ENTRA_ALLOWED_CLIENT_APP_IDS: BOT_CLIENT_ID,
      },
    })['serve']?.run({
      args: [],
      logger: createLogger({ service: 'test', level: 'silent' }),
      stdout: (text) => output.push(text),
    });
    expect(exitCode).toBe(1);
    expect(output.join('')).toContain('Moodle course authorisation');
  });
});
