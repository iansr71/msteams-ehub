import {
  MoodleAuthenticationError,
  MoodleTransportError,
  type MoodleClient,
  type MoodleClientSettings,
} from '@ehub/moodle-client';
import { clearRegisteredSecretValues, createLogger, type CommandContext } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fixtureClient,
  loadFixture,
  type FixtureClientOptions,
} from '../moodle/__fixtures__/fixtureClient.js';
import { createMoodleCommands } from './moodleCommands.js';
import type { MoodleCommandDependencies } from './moodleServices.js';

const TOKEN = 'commandtestfaketoken0123456789abcdef';
const env = { MOODLE_BASE_URL: 'https://ehub.example.test', MOODLE_TOKEN: TOKEN };

interface Harness {
  readonly exitCode: number;
  readonly stdout: string;
  readonly logs: string;
  readonly settingsSeen: MoodleClientSettings[];
}

async function run(
  command: 'moodle:ping' | 'moodle:courses' | 'moodle:inspect',
  args: string[],
  options: {
    fixtures?: FixtureClientOptions;
    client?: MoodleClient;
    env?: Record<string, string>;
  } = {},
): Promise<Harness> {
  const settingsSeen: MoodleClientSettings[] = [];
  const fixture = fixtureClient(options.fixtures);
  const dependencies: MoodleCommandDependencies = {
    env: options.env ?? env,
    createAccess: (settings) => {
      settingsSeen.push(settings);
      return { client: options.client ?? fixture.client, baseUrl: fixture.baseUrl, settings };
    },
  };
  const output: string[] = [];
  const logLines: string[] = [];
  const context: CommandContext = {
    args,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logLines.push(line) },
    }),
    stdout: (text) => output.push(text),
  };
  const exitCode = await createMoodleCommands(dependencies)[command]!.run(context);
  return { exitCode, stdout: output.join('\n'), logs: logLines.join('\n'), settingsSeen };
}

function failingClient(error: Error): MoodleClient {
  const reject = () => Promise.reject(error);
  return {
    getSiteInfo: reject,
    getCourses: reject,
    getCourseContents: reject,
    getEnrolledUsers: reject,
    getUserCourses: reject,
    getUsersByField: reject,
  };
}

afterEach(() => {
  clearRegisteredSecretValues();
});

describe('moodle:ping', () => {
  it('prints a text report and exits 0 when the service is complete', async () => {
    const result = await run('moodle:ping', []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Moodle connection: OK');
    expect(result.settingsSeen[0]).toMatchObject({
      baseUrl: 'https://ehub.example.test',
      token: TOKEN,
    });
  });

  it('prints JSON with --json', async () => {
    const result = await run('moodle:ping', ['--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'ok',
      serviceAccount: { username: 'ehub_assistant' },
    });
  });

  it('exits 1 when required functions are missing', async () => {
    const siteInfo = { ...(loadFixture('site-info') as object), functions: [] };
    const result = await run('moodle:ping', ['--json'], { fixtures: { siteInfo } });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'incomplete' });
  });

  it('reports missing configuration by variable name without calling Moodle', async () => {
    const result = await run('moodle:ping', [], { env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('configuration / invalid_configuration');
    expect(result.stdout).toContain('MOODLE_TOKEN: Required.');
    expect(result.settingsSeen).toHaveLength(0);
  });

  it('reports an invalid token as a sanitized authentication failure with a hint', async () => {
    const error = new MoodleAuthenticationError(
      `Moodle exception (invalidtoken): Invalid token ${TOKEN}`,
      {
        code: 'invalidtoken',
        moodleErrorCode: 'invalidtoken',
        functionName: 'core_webservice_get_site_info',
      },
    );
    const result = await run('moodle:ping', ['--json'], { client: failingClient(error) });
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      status: string;
      error: Record<string, unknown>;
      hint: string;
    };
    expect(report.status).toBe('error');
    expect(report.error).toMatchObject({ category: 'authentication', code: 'invalidtoken' });
    expect(report.hint).toContain('Create a new token');
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.logs).not.toContain(TOKEN);
  });

  it('reports network failures with the network code', async () => {
    const error = new MoodleTransportError(
      'Moodle request failed with a network error (ENOTFOUND).',
      {
        code: 'network_error',
        networkCode: 'ENOTFOUND',
      },
    );
    const result = await run('moodle:ping', [], { client: failingClient(error) });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Network code: ENOTFOUND');
    expect(result.stdout).toContain('Hint: Could not reach Moodle');
  });

  it('rethrows unexpected errors to the CLI boundary', async () => {
    await expect(
      run('moodle:ping', [], { client: failingClient(new RangeError('bug')) }),
    ).rejects.toThrow('bug');
  });
});

describe('moodle:courses', () => {
  it('lists courses as a table', async () => {
    const result = await run('moodle:courses', []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Consultation Standards');
    expect(result.stdout).not.toMatch(/^\s*1\s+ehub/m);
  });

  it('filters by ID and text and supports JSON', async () => {
    const result = await run('moodle:courses', [
      '--course-id',
      '7,12',
      '--search',
      'laser',
      '--json',
    ]);
    const parsed = JSON.parse(result.stdout) as {
      courses: { id: number; courseUrl: string }[];
      returnedByMoodle: number;
    };
    expect(parsed.courses.map((course) => course.id)).toEqual([7]);
    expect(parsed.returnedByMoodle).toBe(2);
    expect(parsed.courses[0]?.courseUrl).toBe('https://ehub.example.test/course/view.php?id=7');
  });

  it('logs counts, never course names or search text', async () => {
    const result = await run('moodle:courses', ['--search', 'laser']);
    expect(result.logs).toContain('"shown":1');
    expect(result.logs).not.toContain('Laser');
    expect(result.logs).not.toContain('laser');
  });

  it.each([
    [['--course-id', 'abc'], '--course-id: must be a positive whole number.'],
    [['--search', '  '], '--search: must not be empty.'],
    [['--search', 'x'.repeat(201)], '--search: must be at most 200 characters.'],
    [['--bogus'], 'Unknown option: --bogus'],
    [['positional'], 'Unexpected argument: positional'],
  ])('rejects %j with exit code 2 before contacting Moodle', async (args, message) => {
    const result = await run('moodle:courses', args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe(message);
    expect(result.settingsSeen).toHaveLength(0);
  });
});

describe('moodle:inspect', () => {
  it('requires --course-id', async () => {
    const result = await run('moodle:inspect', []);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('--course-id: is required.');
  });

  it('prints the course tree and summary', async () => {
    const result = await run('moodle:inspect', ['--course-id', '12'], {
      fixtures: { contents: 'contents-book' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Course 12: Consultation Standards');
    expect(result.stdout).toContain(
      '[701] Skin Analysis Handbook  <book → moodle-book>  supported',
    );
    expect(result.stdout).toContain('chapters: 4');
  });

  it('applies the configured download limit to size checks', async () => {
    const result = await run('moodle:inspect', ['--course-id', '12', '--json'], {
      fixtures: { contents: 'contents-multiple-files' },
      env: { ...env, MOODLE_MAX_DOWNLOAD_BYTES: '100000' },
    });
    const parsed = JSON.parse(result.stdout) as {
      resources: { resourceId: string; support: { reason?: string } }[];
    };
    expect(
      parsed.resources.find((r) => r.resourceId === '801:file:/botox-protocol.pdf')?.support.reason,
    ).toBe('exceeds_size_limit');
  });

  it('outputs course, summary, sections and resources as JSON', async () => {
    const result = await run('moodle:inspect', ['--course-id', '12', '--json'], {
      fixtures: { contents: 'contents-pdf-resource' },
    });
    expect(Object.keys(JSON.parse(result.stdout) as object)).toEqual([
      'course',
      'summary',
      'sections',
      'resources',
    ]);
  });

  it('reports a course the service account cannot see', async () => {
    const result = await run('moodle:inspect', ['--course-id', '999', '--json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { category: 'not_found', code: 'course_not_found' },
    });
  });

  it('refuses to inspect the site front page as a course', async () => {
    const result = await run('moodle:inspect', ['--course-id', '1']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('not_found / course_not_found');
  });

  it('reports a malformed Moodle response with field paths only', async () => {
    const result = await run('moodle:inspect', ['--course-id', '12'], {
      fixtures: { contents: 'contents-malformed' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('validation / response_schema_mismatch');
    expect(result.stdout).toContain('Fields: 0.id, 0.modules.0.modname');
    expect(result.stdout).not.toContain('Consultation checklist');
  });

  it('logs counts only, never names or URLs', async () => {
    const result = await run('moodle:inspect', ['--course-id', '12'], {
      fixtures: { contents: 'contents-pdf-resource' },
    });
    expect(result.logs).toContain('"supportedResources":1');
    expect(result.logs).not.toContain('Consultation');
    expect(result.logs).not.toContain('checklist.pdf');
    expect(result.logs).not.toContain('pluginfile');
  });
});
