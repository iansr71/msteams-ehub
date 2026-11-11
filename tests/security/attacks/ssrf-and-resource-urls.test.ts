import { answerRequestSchema, feedbackRequestSchema } from '@ehub/shared/answers';
import { describe, expect, it } from 'vitest';

import {
  FAKE_TOKEN,
  baseUrl,
  body,
  captureError,
  fastRetryPolicy,
  recordingSleep,
  scriptedFetch,
  status,
  type Handler,
} from '../../../packages/moodle-client/src/__fixtures__/fakeHttp.js';
import { HttpMoodleFileDownloader } from '../../../packages/moodle-client/src/downloader.js';

/*
 * Attack tests: server-side request forgery and unauthorised resource URLs.
 *
 * The only component that fetches a URL taken from data is the Moodle file downloader (URLs
 * come from Moodle's course listing). It must fetch nothing except Moodle file URLs on the
 * configured site, follow redirects only to approved hosts, and never send the Moodle token
 * anywhere else. No API accepts a URL from a user.
 */

const pdf = body(new TextEncoder().encode('%PDF-1.7 ok'), { 'content-type': 'application/pdf' });
const FILE_URL =
  'https://ehub.example.test/webservice/pluginfile.php/900/mod_resource/content/3/checklist.pdf';

function downloader(handlers: Handler[], redirectHosts: string[] = []) {
  const http = scriptedFetch(...handlers);
  return {
    calls: http.calls,
    instance: new HttpMoodleFileDownloader({
      baseUrl,
      token: FAKE_TOKEN,
      downloadTimeoutMs: 5_000,
      maxDownloadBytes: 4_096,
      retryPolicy: fastRetryPolicy,
      fetch: http.fetch,
      sleep: recordingSleep().sleep,
      random: () => 0.5,
      ...(redirectHosts.length === 0 ? {} : { additionalRedirectHosts: redirectHosts }),
    }),
  };
}

describe('attack: SSRF through a download URL', () => {
  it.each([
    [
      'the cloud metadata service',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    ],
    ['metadata over https', 'https://169.254.169.254/webservice/pluginfile.php/1/a.pdf'],
    ['this machine', 'https://127.0.0.1/webservice/pluginfile.php/1/a.pdf'],
    ['localhost', 'https://localhost:3000/admin/api/actions/incremental-sync'],
    ['a decimal IP', 'https://2130706433/webservice/pluginfile.php/1/a.pdf'],
    ['an IPv6 loopback', 'https://[::1]/webservice/pluginfile.php/1/a.pdf'],
    ['an internal host', 'https://intranet.internal/webservice/pluginfile.php/1/a.pdf'],
    ['another site', 'https://evil.example/webservice/pluginfile.php/1/a.pdf'],
    [
      'a look-alike host',
      'https://ehub.example.test.evil.example/webservice/pluginfile.php/1/a.pdf',
    ],
    [
      'a user-info trick',
      'https://ehub.example.test@evil.example/webservice/pluginfile.php/1/a.pdf',
    ],
    ['a different port', 'https://ehub.example.test:8443/webservice/pluginfile.php/1/a.pdf'],
    ['plain http', 'http://ehub.example.test/webservice/pluginfile.php/1/a.pdf'],
    ['a file URL', 'file:///etc/passwd'],
    ['a gopher URL', 'gopher://ehub.example.test/_GET'],
    ['a relative path', '/webservice/pluginfile.php/1/a.pdf'],
    ['a protocol-relative URL', '//evil.example/webservice/pluginfile.php/1/a.pdf'],
  ])('makes no request for %s', async (_label, url) => {
    const { instance, calls } = downloader([]);
    const error = await captureError(instance.download(url));
    expect(error).toMatchObject({ code: 'invalid_file_url' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['metadata over https', 'https://169.254.169.254/latest/meta-data/'],
    ['this machine', 'https://127.0.0.1:3000/admin/'],
    ['localhost', 'https://localhost/'],
    ['another site', 'https://evil.example/collect'],
    ['a look-alike host', 'https://ehub.example.test.evil.example/x'],
    ['a user-info trick', 'https://ehub.example.test@evil.example/x'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['plain http on the same host', 'http://ehub.example.test/webservice/pluginfile.php/1/a.pdf'],
    ['a file URL', 'file:///etc/passwd'],
  ])(
    'does not follow a redirect to %s, and the token goes nowhere else',
    async (_label, location) => {
      const { instance, calls } = downloader([status(302, { location })]);
      const error = await captureError(instance.download(FILE_URL));
      expect(error).toMatchObject({ retryable: false });
      expect((error as { code: string }).code).toMatch(/unsafe_redirect|invalid_redirect/);
      // Exactly one request was made: to Moodle, with the token.
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]?.url ?? '').host).toBe('ehub.example.test');
      expect((error as Error).message).not.toContain(FAKE_TOKEN);
    },
  );

  it('stops a redirect loop', async () => {
    const loop = status(302, { location: FILE_URL });
    const { instance, calls } = downloader(Array.from({ length: 12 }, () => loop));
    const error = await captureError(instance.download(FILE_URL));
    expect(error).toMatchObject({ code: 'too_many_redirects' });
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('never sends the token to an approved redirect host', async () => {
    const { instance, calls } = downloader(
      [status(302, { location: 'https://files.example.test/blob/abc' }), pdf],
      ['files.example.test'],
    );
    await instance.download(FILE_URL);
    expect(calls[0]?.url).toContain(FAKE_TOKEN);
    expect(calls[1]?.url).toBe('https://files.example.test/blob/abc');
    expect(JSON.stringify(calls[1])).not.toContain(FAKE_TOKEN);
  });

  it('cannot be configured to approve a local address as a redirect host', () => {
    for (const host of ['localhost', '127.0.0.1', '169.254.169.254', '[::1]:8080']) {
      expect(() => downloader([], [host])).toThrow(/loopback, link-local or metadata/);
    }
  });

  it('stops reading a response larger than the limit', async () => {
    const huge = body(new Uint8Array(8_192), { 'content-type': 'application/pdf' });
    const { instance } = downloader([huge]);
    const error = await captureError(instance.download(FILE_URL));
    expect((error as { code: string }).code).toMatch(/too_large|size/);
  });
});

describe('attack: unauthorised resource URL', () => {
  it.each([
    ['the Moodle admin area', 'https://ehub.example.test/admin/settings.php'],
    ['the login page', 'https://ehub.example.test/login/index.php'],
    [
      'the web-service endpoint',
      'https://ehub.example.test/webservice/rest/server.php?wsfunction=core_user_get_users',
    ],
    ['the config file', 'https://ehub.example.test/config.php'],
    [
      'a traversal out of pluginfile',
      'https://ehub.example.test/webservice/pluginfile.php/../../config.php',
    ],
    [
      'an encoded traversal',
      'https://ehub.example.test/webservice/pluginfile.php/1/..%2f..%2f..%2fconfig.php',
    ],
    [
      'a doubly encoded separator',
      'https://ehub.example.test/webservice/pluginfile.php/1/%252e%252e%2fconfig.php',
    ],
    [
      'a backslash traversal',
      'https://ehub.example.test/webservice/pluginfile.php/1/..%5c..%5cconfig.php',
    ],
    ['a prefix look-alike', 'https://ehub.example.test/webservice/pluginfile.phpx/1/a.pdf'],
  ])('refuses %s without making a request', async (_label, url) => {
    const { instance, calls } = downloader([]);
    const error = await captureError(instance.download(url));
    expect(error).toMatchObject({ code: 'invalid_file_url' });
    expect(calls).toHaveLength(0);
  });

  it('drops credentials an attacker put in a file URL instead of forwarding them', async () => {
    const { instance, calls } = downloader([pdf]);
    const file = await instance.download(`${FILE_URL}?token=attacker-token&wstoken=other`);
    expect(calls[0]?.url).not.toContain('attacker-token');
    expect(calls[0]?.url).not.toContain('wstoken=other');
    expect(file.finalUrl).not.toContain('token');
  });

  it('gives users no way to name a URL: the request schemas accept none', () => {
    for (const field of ['url', 'sourceUrl', 'fileUrl', 'resourceUrl', 'callback', 'webhook']) {
      expect(
        answerRequestSchema.safeParse({ question: 'x', [field]: 'https://evil.example/' }).success,
      ).toBe(false);
      expect(
        feedbackRequestSchema.safeParse({
          answerId: 'a',
          rating: 'useful',
          [field]: 'https://evil.example/',
        }).success,
      ).toBe(false);
    }
  });
});
