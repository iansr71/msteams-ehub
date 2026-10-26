import { ConfigValidationError, MOODLE_DEFAULTS } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import { FAKE_TOKEN, json, scriptedFetch } from './__fixtures__/fakeHttp.js';
import * as fixtures from './__fixtures__/responses.js';
import { MoodleValidationError } from './errors.js';
import { createMoodleServices, loadMoodleSettings } from './factory.js';

const env = {
  MOODLE_BASE_URL: 'https://ehub.example.test/',
  MOODLE_TOKEN: FAKE_TOKEN,
};

describe('loadMoodleSettings', () => {
  it('reads validated configuration with defaults', () => {
    expect(loadMoodleSettings(env)).toEqual({
      baseUrl: 'https://ehub.example.test/',
      token: FAKE_TOKEN,
      requestTimeoutMs: MOODLE_DEFAULTS.requestTimeoutMs,
      downloadTimeoutMs: MOODLE_DEFAULTS.downloadTimeoutMs,
      maxDownloadBytes: MOODLE_DEFAULTS.maxDownloadBytes,
      maxRetries: MOODLE_DEFAULTS.maxRetries,
      allowHttp: true,
    });
  });

  it('reads configured limits', () => {
    const settings = loadMoodleSettings({
      ...env,
      MOODLE_REQUEST_TIMEOUT_MS: '5000',
      MOODLE_DOWNLOAD_TIMEOUT_MS: '60000',
      MOODLE_MAX_DOWNLOAD_BYTES: '2048',
      MOODLE_MAX_RETRIES: '0',
    });
    expect(settings).toMatchObject({
      requestTimeoutMs: 5_000,
      downloadTimeoutMs: 60_000,
      maxDownloadBytes: 2_048,
      maxRetries: 0,
    });
  });

  it.each([
    ['MOODLE_REQUEST_TIMEOUT_MS', '10'],
    ['MOODLE_DOWNLOAD_TIMEOUT_MS', 'soon'],
    ['MOODLE_MAX_DOWNLOAD_BYTES', '-1'],
    ['MOODLE_MAX_RETRIES', '50'],
  ])('rejects out-of-range %s', (variable, value) => {
    expect(() => loadMoodleSettings({ ...env, [variable]: value })).toThrow(ConfigValidationError);
  });

  it('disallows http in production and never echoes the token', () => {
    try {
      loadMoodleSettings({
        ...env,
        NODE_ENV: 'production',
        MOODLE_BASE_URL: 'http://ehub.example.test',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).not.toContain(FAKE_TOKEN);
      return;
    }
    throw new Error('expected rejection');
  });

  it('reports a missing token by name', () => {
    expect(() => loadMoodleSettings({ MOODLE_BASE_URL: env.MOODLE_BASE_URL })).toThrow(
      /MOODLE_TOKEN: Required/,
    );
  });
});

describe('createMoodleServices', () => {
  it('wires the client, transport and downloader to the injected fetch', async () => {
    const http = scriptedFetch(json(fixtures.siteInfo));
    const services = createMoodleServices(loadMoodleSettings(env), { fetch: http.fetch });

    expect(services.baseUrl.restEndpoint).toBe(
      'https://ehub.example.test/webservice/rest/server.php',
    );
    await expect(services.client.getSiteInfo()).resolves.toMatchObject({ sitename: 'E-Hub' });
    expect(http.calls).toHaveLength(1);
  });

  it('rejects http base URLs when http is not allowed', () => {
    expect(() =>
      createMoodleServices({
        ...loadMoodleSettings(env),
        baseUrl: 'http://x.test',
        allowHttp: false,
      }),
    ).toThrow(MoodleValidationError);
  });
});
