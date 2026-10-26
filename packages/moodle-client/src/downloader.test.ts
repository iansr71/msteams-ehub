import { describe, expect, it } from 'vitest';

import {
  FAKE_TOKEN,
  baseUrl,
  body,
  captureError,
  fastRetryPolicy,
  hang,
  json,
  networkFailure,
  recordingSleep,
  scriptedFetch,
  status,
  type Handler,
} from './__fixtures__/fakeHttp.js';
import { normalizeMoodleBaseUrl } from './baseUrl.js';
import { HttpMoodleFileDownloader, type HttpMoodleFileDownloaderOptions } from './downloader.js';
import {
  MoodleAuthenticationError,
  MoodleAuthorizationError,
  MoodleTransportError,
  MoodleValidationError,
} from './errors.js';

const FILE_URL =
  'https://ehub.example.test/webservice/pluginfile.php/900/mod_resource/content/3/checklist.pdf?forcedownload=1';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 fake pdf bytes');

function downloader(handlers: Handler[], overrides: Partial<HttpMoodleFileDownloaderOptions> = {}) {
  const http = scriptedFetch(...handlers);
  const sleeper = recordingSleep();
  const instance = new HttpMoodleFileDownloader({
    baseUrl,
    token: FAKE_TOKEN,
    downloadTimeoutMs: 5_000,
    maxDownloadBytes: 1_024,
    retryPolicy: fastRetryPolicy,
    fetch: http.fetch,
    sleep: sleeper.sleep,
    random: () => 0.5,
    ...overrides,
  });
  return { instance, calls: http.calls };
}

const pdf = body(PDF_BYTES, {
  'content-type': 'application/pdf',
  'last-modified': 'Wed, 01 Oct 2025 10:00:00 GMT',
});

describe('HttpMoodleFileDownloader success path', () => {
  it('downloads a file, adding the token only to the outgoing request', async () => {
    const { instance, calls } = downloader([pdf]);

    const file = await instance.download(FILE_URL);

    const requested = new URL(calls[0]!.url);
    expect(requested.searchParams.get('token')).toBe(FAKE_TOKEN);
    expect(requested.searchParams.get('forcedownload')).toBe('1');
    expect(calls[0]?.init.redirect).toBe('manual');

    expect(file.sourceUrl).toBe(FILE_URL);
    expect(file.finalUrl).toBe(FILE_URL);
    expect(file.redirectCount).toBe(0);
    expect(file.contentType).toBe('application/pdf');
    expect(file.lastModified).toBe('Wed, 01 Oct 2025 10:00:00 GMT');
    expect(file.byteLength).toBe(PDF_BYTES.byteLength);
    expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.7 fake pdf bytes');
    expect(JSON.stringify({ ...file, bytes: undefined })).not.toContain(FAKE_TOKEN);
  });

  it('rewrites plain pluginfile URLs to the token-aware web-service endpoint', async () => {
    const { instance, calls } = downloader([pdf]);
    const plain = 'https://ehub.example.test/pluginfile.php/900/mod_page/content/1/image.png';

    const file = await instance.download(plain);

    expect(new URL(calls[0]!.url).pathname).toBe(
      '/webservice/pluginfile.php/900/mod_page/content/1/image.png',
    );
    expect(file.sourceUrl).toBe(plain);
  });

  it('strips any token already present in the supplied URL from the source URL', async () => {
    const { instance, calls } = downloader([pdf]);
    const file = await instance.download(`${FILE_URL}&token=someoneelsestoken&wstoken=another`);
    expect(file.sourceUrl).toBe(FILE_URL);
    expect(new URL(calls[0]!.url).searchParams.getAll('token')).toEqual([FAKE_TOKEN]);
    expect(calls[0]!.url).not.toContain('someoneelsestoken');
    expect(calls[0]!.url).not.toContain('wstoken');
  });

  it('supports Moodle installed in a sub-directory', async () => {
    const subdirectory = normalizeMoodleBaseUrl('https://ehub.example.test/moodle', {
      allowHttp: false,
    });
    const { instance } = downloader([pdf], { baseUrl: subdirectory });
    await expect(
      instance.download('https://ehub.example.test/moodle/webservice/pluginfile.php/1/a/b.pdf'),
    ).resolves.toBeDefined();
    await expect(
      instance.download('https://ehub.example.test/webservice/pluginfile.php/1/a/b.pdf'),
    ).rejects.toThrow(/pluginfile/);
  });
});

describe('HttpMoodleFileDownloader URL validation', () => {
  it.each([
    ['not a URL', 'pluginfile.php/1/x.pdf'],
    ['another host', 'https://evil.example.test/webservice/pluginfile.php/1/x.pdf'],
    ['look-alike host', 'https://ehub.example.test.evil.test/webservice/pluginfile.php/1/x.pdf'],
    ['plain http', 'http://ehub.example.test/webservice/pluginfile.php/1/x.pdf'],
    ['credentials in URL', 'https://user:pw@ehub.example.test/webservice/pluginfile.php/1/x.pdf'],
    ['non-pluginfile path', 'https://ehub.example.test/admin/settings.php'],
    ['REST endpoint', 'https://ehub.example.test/webservice/rest/server.php'],
    ['traversal out of pluginfile', 'https://ehub.example.test/pluginfile.php/../admin/x'],
    ['encoded slash', 'https://ehub.example.test/pluginfile.php/1/..%2f..%2fadmin'],
    ['file scheme', 'file:///etc/passwd'],
    ['loopback', 'https://127.0.0.1/webservice/pluginfile.php/1/x.pdf'],
  ])('rejects %s without making a request', async (_label, url) => {
    const { instance, calls } = downloader([]);
    const error = await captureError(instance.download(url));
    expect(error).toBeInstanceOf(MoodleValidationError);
    expect(error).toMatchObject({ code: 'invalid_file_url' });
    expect(calls).toHaveLength(0);
  });
});

describe('HttpMoodleFileDownloader redirects', () => {
  it('follows a redirect to an approved host without forwarding the token', async () => {
    const { instance, calls } = downloader(
      [status(302, { location: 'https://files.example.test/blob/abc?sig=1' }), pdf],
      { additionalRedirectHosts: ['FILES.example.test'] },
    );

    const file = await instance.download(FILE_URL);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://files.example.test/blob/abc?sig=1');
    expect(calls[1]!.url).not.toContain(FAKE_TOKEN);
    expect(file.sourceUrl).toBe(FILE_URL);
    expect(file.finalUrl).toBe('https://files.example.test/blob/abc?sig=1');
    expect(file.redirectCount).toBe(1);
  });

  it('removes token parameters from a same-host redirect instead of resending them', async () => {
    const { instance, calls } = downloader([
      status(303, { location: `/webservice/pluginfile.php/900/other.pdf?token=${FAKE_TOKEN}` }),
      pdf,
    ]);
    const file = await instance.download(FILE_URL);
    expect(calls[1]!.url).toBe('https://ehub.example.test/webservice/pluginfile.php/900/other.pdf');
    expect(file.finalUrl).not.toContain(FAKE_TOKEN);
  });

  it.each([
    ['an unapproved host', 'https://evil.example.test/steal'],
    ['plain http', 'http://ehub.example.test/webservice/pluginfile.php/1/x'],
    ['an IP address', 'https://169.254.169.254/latest/meta-data/'],
    ['localhost', 'https://localhost/admin'],
    ['credentials', 'https://u:p@ehub.example.test/x'],
  ])('blocks a redirect to %s', async (_label, location) => {
    const { instance, calls } = downloader([status(302, { location })]);
    const error = await captureError(instance.download(FILE_URL));
    expect(error).toBeInstanceOf(MoodleTransportError);
    expect(error).toMatchObject({ code: 'unsafe_redirect', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('treats a redirect to the Moodle login page as an authentication failure', async () => {
    const { instance } = downloader([
      status(303, { location: 'https://ehub.example.test/login/index.php' }),
    ]);
    const error = await captureError(instance.download(FILE_URL));
    expect(error).toBeInstanceOf(MoodleAuthenticationError);
    expect(error).toMatchObject({ code: 'login_redirect' });
  });

  it('limits the number of redirects', async () => {
    const hop = status(302, { location: '/webservice/pluginfile.php/900/again.pdf' });
    const { instance, calls } = downloader([hop, hop, hop], { maxRedirects: 2 });
    expect(await captureError(instance.download(FILE_URL))).toMatchObject({
      code: 'too_many_redirects',
    });
    expect(calls).toHaveLength(3);
  });

  it('rejects a redirect without a location', async () => {
    const { instance } = downloader([status(302)]);
    expect(await captureError(instance.download(FILE_URL))).toMatchObject({
      code: 'invalid_redirect',
    });
  });
});

describe('HttpMoodleFileDownloader limits and failures', () => {
  it('rejects a declared Content-Length over the limit before reading the body', async () => {
    const { instance } = downloader([
      body(new Uint8Array(10), { 'content-type': 'application/pdf', 'content-length': '5000' }),
    ]);
    const error = await captureError(instance.download(FILE_URL));
    expect(error).toBeInstanceOf(MoodleValidationError);
    expect(error).toMatchObject({ code: 'file_too_large' });
  });

  it('stops streaming when an undeclared body exceeds the limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512));
      },
    });
    const { instance } = downloader([() => new Response(stream, { status: 200 })]);
    expect(await captureError(instance.download(FILE_URL))).toMatchObject({
      code: 'file_too_large',
    });
  });

  it('allows a caller to lower, but not raise, the size limit', async () => {
    const { instance } = downloader([pdf, pdf]);
    expect(await captureError(instance.download(FILE_URL, { maxBytes: 5 }))).toMatchObject({
      code: 'file_too_large',
    });
    await expect(instance.download(FILE_URL, { maxBytes: 10_000_000 })).resolves.toBeDefined();
    await expect(instance.download(FILE_URL, { maxBytes: 0 })).rejects.toBeInstanceOf(
      MoodleValidationError,
    );
  });

  it('times out a slow download', async () => {
    const { instance } = downloader([hang], { downloadTimeoutMs: 20 });
    expect(await captureError(instance.download(FILE_URL))).toMatchObject({
      code: 'timeout',
      category: 'transport',
    });
  });

  it('retries transient failures', async () => {
    const { instance, calls } = downloader([status(503), networkFailure('ECONNRESET'), pdf]);
    await expect(instance.download(FILE_URL)).resolves.toMatchObject({
      byteLength: PDF_BYTES.byteLength,
    });
    expect(calls).toHaveLength(3);
  });

  it.each([
    [401, MoodleAuthenticationError],
    [403, MoodleAuthorizationError],
    [404, MoodleValidationError],
  ])('does not retry HTTP %i', async (code, errorType) => {
    const { instance, calls } = downloader([status(code)]);
    expect(await captureError(instance.download(FILE_URL))).toBeInstanceOf(errorType);
    expect(calls).toHaveLength(1);
  });

  it('detects a Moodle exception returned as the file body', async () => {
    const { instance } = downloader([
      json({ error: 'Invalid token - token not found', errorcode: 'invalidtoken' }),
    ]);
    expect(await captureError(instance.download(FILE_URL))).toBeInstanceOf(
      MoodleAuthenticationError,
    );
  });

  it('returns a genuine JSON file untouched', async () => {
    const { instance } = downloader([json({ title: 'A JSON course resource' })]);
    const file = await instance.download(FILE_URL);
    expect(file.contentType).toContain('application/json');
  });
});
