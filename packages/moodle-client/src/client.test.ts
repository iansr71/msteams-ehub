import { describe, expect, it } from 'vitest';

import { captureError } from './__fixtures__/fakeHttp.js';
import * as fixtures from './__fixtures__/responses.js';
import { DefaultMoodleClient } from './client.js';
import { MoodleValidationError } from './errors.js';
import { encodeMoodleParams, type MoodleParams } from './params.js';
import type { MoodleFunctionName, MoodleTransport } from './transport.js';

interface RecordedTransportCall {
  readonly functionName: MoodleFunctionName;
  readonly params: MoodleParams;
}

function clientReturning(result: unknown) {
  const calls: RecordedTransportCall[] = [];
  const transport: MoodleTransport = {
    call: (functionName, params) => {
      calls.push({ functionName, params });
      return Promise.resolve(result);
    },
  };
  return { client: new DefaultMoodleClient(transport), calls };
}

function encoded(call: RecordedTransportCall | undefined): [string, string][] {
  return call === undefined ? [] : [...encodeMoodleParams(call.params)];
}

describe('DefaultMoodleClient', () => {
  it('getSiteInfo validates and returns site info', async () => {
    const { client, calls } = clientReturning(fixtures.siteInfo);
    const info = await client.getSiteInfo();
    expect(calls[0]?.functionName).toBe('core_webservice_get_site_info');
    expect(info).toMatchObject({ sitename: 'E-Hub', userid: 42, downloadfiles: 1 });
    expect(info.functions.map((fn) => fn.name)).toContain('core_course_get_contents');
  });

  it('getCourses returns all courses, or only the requested IDs', async () => {
    const { client, calls } = clientReturning(fixtures.courses);
    const all = await client.getCourses();
    expect(all.map((course) => course.id)).toEqual([1, 12]);
    expect(encoded(calls[0])).toEqual([]);

    await client.getCourses([12, 15]);
    expect(encoded(calls[1])).toEqual([
      ['options[ids][0]', '12'],
      ['options[ids][1]', '15'],
    ]);
  });

  it('getCourseContents validates sections, modules and files', async () => {
    const { client, calls } = clientReturning(fixtures.courseContents);
    const sections = await client.getCourseContents(12);
    expect(calls[0]?.functionName).toBe('core_course_get_contents');
    expect(encoded(calls[0])).toEqual([['courseid', '12']]);
    const file = sections[0]?.modules[0]?.contents?.[0];
    expect(file).toMatchObject({
      type: 'file',
      filename: 'checklist.pdf',
      mimetype: 'application/pdf',
    });
    expect(file?.fileurl).toContain('/webservice/pluginfile.php/');
  });

  it('getCourseContents can exclude file contents', async () => {
    const { client, calls } = clientReturning([]);
    await client.getCourseContents(12, { excludeContents: true });
    expect(encoded(calls[0])).toEqual([
      ['courseid', '12'],
      ['options[0][name]', 'excludecontents'],
      ['options[0][value]', '1'],
    ]);
  });

  it('getEnrolledUsers passes paging options and strips undeclared personal data', async () => {
    const { client, calls } = clientReturning(fixtures.enrolledUsers);
    const users = await client.getEnrolledUsers(12, {
      onlyActive: true,
      limitFrom: 0,
      limitNumber: 50,
    });
    expect(encoded(calls[0])).toEqual([
      ['courseid', '12'],
      ['options[0][name]', 'onlyactive'],
      ['options[0][value]', '1'],
      ['options[1][name]', 'limitfrom'],
      ['options[1][value]', '0'],
      ['options[2][name]', 'limitnumber'],
      ['options[2][value]', '50'],
    ]);
    expect(users[0]).toMatchObject({
      id: 77,
      fullname: 'Jane Doe',
      email: 'jane.doe@example.test',
    });
    expect(users[0]).not.toHaveProperty('phone1');
    expect(users[0]).not.toHaveProperty('address');
    expect(users[0]).not.toHaveProperty('enrolledcourses');
  });

  it('getUserCourses requests without per-course user counts', async () => {
    const { client, calls } = clientReturning(fixtures.userCourses);
    const courses = await client.getUserCourses(77);
    expect(encoded(calls[0])).toEqual([
      ['userid', '77'],
      ['returnusercount', '0'],
    ]);
    expect(courses[0]).toMatchObject({ id: 12, visible: 1, hidden: false });
  });

  it('getUsersByField looks users up and strips profile fields', async () => {
    const { client, calls } = clientReturning(fixtures.users);
    const users = await client.getUsersByField('email', ['jane.doe@example.test']);
    expect(encoded(calls[0])).toEqual([
      ['field', 'email'],
      ['values[0]', 'jane.doe@example.test'],
    ]);
    expect(users[0]).toMatchObject({ id: 77, auth: 'oauth2', suspended: false });
    expect(users[0]).not.toHaveProperty('customfields');
    expect(users[0]).not.toHaveProperty('preferences');
  });

  it.each([
    ['site info missing userid', 'getSiteInfo', { ...fixtures.siteInfo, userid: undefined }],
    ['courses not an array', 'getCourses', { id: 1 }],
    ['course id as string', 'getCourses', [{ ...fixtures.courses[1], id: '12' }]],
    ['section without modules', 'getCourseContents', [{ id: 1, name: 'x' }]],
    [
      'visible flag out of range',
      'getCourseContents',
      [{ id: 1, name: 'x', visible: 7, modules: [] }],
    ],
    ['user without fullname', 'getUsersByField', [{ id: 1 }]],
    ['null response', 'getUserCourses', null],
  ] as const)('rejects a malformed response: %s', async (_label, method, response) => {
    const { client } = clientReturning(response);
    const call = (): Promise<unknown> => {
      switch (method) {
        case 'getSiteInfo':
          return client.getSiteInfo();
        case 'getCourses':
          return client.getCourses();
        case 'getCourseContents':
          return client.getCourseContents(1);
        case 'getUsersByField':
          return client.getUsersByField('id', ['1']);
        case 'getUserCourses':
          return client.getUserCourses(1);
      }
    };
    const error = await captureError(call());
    expect(error).toBeInstanceOf(MoodleValidationError);
    expect(error).toMatchObject({ code: 'response_schema_mismatch' });
    expect((error as MoodleValidationError).issuePaths?.length).toBeGreaterThan(0);
  });

  it('does not copy response values into schema errors', async () => {
    const { client } = clientReturning([{ id: 'secret-looking-value-123', fullname: 'X' }]);
    const error = await captureError(client.getUsersByField('id', ['1']));
    expect(JSON.stringify(error)).not.toContain('secret-looking-value-123');
    expect(String(error)).not.toContain('secret-looking-value-123');
  });

  it.each([
    ['zero course ID', (c: DefaultMoodleClient) => c.getCourseContents(0)],
    ['fractional course ID', (c: DefaultMoodleClient) => c.getCourseContents(1.5)],
    ['negative user ID', (c: DefaultMoodleClient) => c.getUserCourses(-3)],
    ['empty ID list', (c: DefaultMoodleClient) => c.getCourses([])],
    ['NaN in ID list', (c: DefaultMoodleClient) => c.getCourses([Number.NaN])],
    [
      'too many IDs',
      (c: DefaultMoodleClient) => c.getCourses(Array.from({ length: 501 }, (_, i) => i + 1)),
    ],
    ['empty lookup list', (c: DefaultMoodleClient) => c.getUsersByField('email', [])],
    ['blank lookup value', (c: DefaultMoodleClient) => c.getUsersByField('email', [' '])],
    [
      'oversized lookup value',
      (c: DefaultMoodleClient) => c.getUsersByField('email', ['x'.repeat(256)]),
    ],
    [
      'unsupported lookup field',
      (c: DefaultMoodleClient) => c.getUsersByField('password' as 'email', ['x']),
    ],
    [
      'page size too large',
      (c: DefaultMoodleClient) => c.getEnrolledUsers(1, { limitNumber: 5000 }),
    ],
    ['negative page start', (c: DefaultMoodleClient) => c.getEnrolledUsers(1, { limitFrom: -1 })],
  ])('rejects invalid input (%s) without calling Moodle', async (_label, invoke) => {
    const { client, calls } = clientReturning([]);
    const error = await captureError(invoke(client));
    expect(error).toBeInstanceOf(MoodleValidationError);
    expect(error).toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
});
