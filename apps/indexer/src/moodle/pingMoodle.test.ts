import { MoodleAuthenticationError, SUPPORTED_MOODLE_FUNCTIONS } from '@ehub/moodle-client';
import { describe, expect, it } from 'vitest';

import { fixtureClient, loadFixture } from './__fixtures__/fixtureClient.js';
import { pingMoodle } from './pingMoodle.js';

const siteInfo = loadFixture('site-info') as Record<string, unknown>;

function withFunctions(names: readonly string[], extra: Record<string, unknown> = {}) {
  return { ...siteInfo, functions: names.map((name) => ({ name, version: '1' })), ...extra };
}

describe('pingMoodle', () => {
  it('reports OK when the service exposes exactly the expected functions', async () => {
    const { client, baseUrl } = fixtureClient();
    expect(await pingMoodle(client, baseUrl)).toEqual({
      status: 'ok',
      site: {
        name: 'E-Hub',
        url: 'https://ehub.example.test',
        release: '5.0.2 (Build: 20250811)',
        version: '2025041402.00',
      },
      serviceAccount: { username: 'ehub_assistant', userId: 42 },
      downloadFilesEnabled: true,
      functions: { expected: SUPPORTED_MOODLE_FUNCTIONS, missing: [], unexpected: [] },
      warnings: [],
    });
  });

  it('is incomplete when a required function is missing', async () => {
    const { client, baseUrl } = fixtureClient({
      siteInfo: withFunctions(
        SUPPORTED_MOODLE_FUNCTIONS.filter((name) => name !== 'core_course_get_contents'),
      ),
    });
    const report = await pingMoodle(client, baseUrl);
    expect(report.status).toBe('incomplete');
    expect(report.functions.missing).toEqual(['core_course_get_contents']);
    expect(report.warnings).toEqual(['missing_functions']);
  });

  it('warns, but stays OK, when the service exposes more than needed', async () => {
    const { client, baseUrl } = fixtureClient({
      siteInfo: withFunctions([
        ...SUPPORTED_MOODLE_FUNCTIONS,
        'core_user_create_users',
        'core_course_delete_courses',
      ]),
    });
    const report = await pingMoodle(client, baseUrl);
    expect(report.status).toBe('ok');
    expect(report.functions.unexpected).toEqual([
      'core_course_delete_courses',
      'core_user_create_users',
    ]);
    expect(report.warnings).toEqual(['unexpected_functions']);
  });

  it('is incomplete when file downloads are disabled for the service', async () => {
    const { client, baseUrl } = fixtureClient({
      siteInfo: withFunctions(SUPPORTED_MOODLE_FUNCTIONS, { downloadfiles: 0 }),
    });
    const report = await pingMoodle(client, baseUrl);
    expect(report).toMatchObject({
      status: 'incomplete',
      downloadFilesEnabled: false,
      warnings: ['file_downloads_disabled'],
    });
  });

  it('warns when Moodle reports a different site URL', async () => {
    const { client, baseUrl } = fixtureClient({
      siteInfo: withFunctions(SUPPORTED_MOODLE_FUNCTIONS, {
        siteurl: 'https://old-name.example.test/moodle',
      }),
    });
    expect((await pingMoodle(client, baseUrl)).warnings).toEqual(['site_url_mismatch']);
  });

  it('propagates sanitized Moodle errors', async () => {
    const failing = {
      getSiteInfo: () =>
        Promise.reject(new MoodleAuthenticationError('Invalid token', { code: 'invalidtoken' })),
    };
    const { baseUrl } = fixtureClient();
    await expect(
      pingMoodle(failing as unknown as Parameters<typeof pingMoodle>[0], baseUrl),
    ).rejects.toBeInstanceOf(MoodleAuthenticationError);
  });
});
