import { describe, expect, it } from 'vitest';

import {
  FAKE_TOKEN,
  baseUrl,
  body,
  captureError,
  fastRetryPolicy,
  hang,
  json,
  memoryLogger,
  networkFailure,
  recordingSleep,
  scriptedFetch,
  status,
  type Handler,
} from './__fixtures__/fakeHttp.js';
import {
  MoodleApiError,
  MoodleAuthenticationError,
  MoodleAuthorizationError,
  MoodleRateLimitError,
  MoodleTransportError,
  MoodleValidationError,
} from './errors.js';
import { HttpMoodleTransport, type HttpMoodleTransportOptions } from './transport.js';

function transport(handlers: Handler[], overrides: Partial<HttpMoodleTransportOptions> = {}) {
  const http = scriptedFetch(...handlers);
  const sleeper = recordingSleep();
  const log = memoryLogger();
  const instance = new HttpMoodleTransport({
    baseUrl,
    token: FAKE_TOKEN,
    requestTimeoutMs: 5_000,
    retryPolicy: fastRetryPolicy,
    fetch: http.fetch,
    sleep: sleeper.sleep,
    random: () => 0.5,
    logger: log.logger,
    ...overrides,
  });
  return { instance, calls: http.calls, delays: sleeper.delays, logLines: log.lines };
}

describe('HttpMoodleTransport request', () => {
  it('POSTs form data to the REST endpoint with the token only in the body', async () => {
    const { instance, calls } = transport([json({ ok: true })]);

    await instance.call('core_course_get_contents', { courseid: 7 });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://ehub.example.test/webservice/rest/server.php');
    expect(call?.url).not.toContain(FAKE_TOKEN);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    expect(call?.form?.get('wstoken')).toBe(FAKE_TOKEN);
    expect(call?.form?.get('wsfunction')).toBe('core_course_get_contents');
    expect(call?.form?.get('moodlewsrestformat')).toBe('json');
    expect(call?.form?.get('courseid')).toBe('7');
    expect(call?.form?.getAll('wstoken')).toHaveLength(1);
  });

  it('returns the decoded JSON body', async () => {
    const { instance } = transport([json([{ id: 1 }])]);
    await expect(instance.call('core_course_get_courses', {})).resolves.toEqual([{ id: 1 }]);
  });

  it.each(['wstoken', 'WSTOKEN', 'wsfunction', 'moodlewsrestformat'])(
    'rejects the reserved parameter %s without calling Moodle',
    async (name) => {
      const { instance, calls } = transport([]);
      const error = await captureError(instance.call('core_course_get_courses', { [name]: 'x' }));
      expect(error).toBeInstanceOf(MoodleValidationError);
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects an empty token at construction', () => {
    expect(
      () => new HttpMoodleTransport({ baseUrl, token: '  ', requestTimeoutMs: 1_000 }),
    ).toThrow(MoodleValidationError);
  });
});

describe('HttpMoodleTransport retries', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %i and then succeeds', async (code) => {
    const { instance, calls, delays } = transport([status(code), status(code), json({ ok: 1 })]);
    await expect(instance.call('core_webservice_get_site_info', {})).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([5, 10]);
  });

  it.each([
    ['ECONNRESET', 'connection reset'],
    ['UND_ERR_SOCKET', 'socket closed by peer'],
    ['EAI_AGAIN', 'temporary DNS failure'],
  ])('retries network error %s (%s)', async (code) => {
    const { instance, calls } = transport([networkFailure(code), json({ ok: 1 })]);
    await expect(instance.call('core_webservice_get_site_info', {})).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it('stops after maxRetries and surfaces the last error', async () => {
    const { instance, calls } = transport([status(503), status(503), status(503), status(503)]);
    const error = await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(error).toBeInstanceOf(MoodleTransportError);
    expect(error).toMatchObject({ code: 'http_503', httpStatus: 503, retryable: true });
    expect(calls).toHaveLength(4);
  });

  it('honours Retry-After on 429 and reports a rate-limit error when exhausted', async () => {
    const limited = status(429, { 'retry-after': '2' });
    const { instance, delays } = transport([limited, limited, limited, limited]);
    const error = await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(error).toBeInstanceOf(MoodleRateLimitError);
    expect(delays).toEqual([2_000, 2_000, 2_000]);
  });

  it('does not wait for a Retry-After beyond the policy maximum', async () => {
    const { instance, calls } = transport([status(503, { 'retry-after': '600' })]);
    await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(calls).toHaveLength(1);
  });

  it.each([
    [400, MoodleValidationError],
    [401, MoodleAuthenticationError],
    [403, MoodleAuthorizationError],
    [404, MoodleValidationError],
    [413, MoodleValidationError],
    [501, MoodleApiError],
  ])('does not retry HTTP %i', async (code, errorType) => {
    const { instance, calls } = transport([status(code)]);
    const error = await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(error).toBeInstanceOf(errorType);
    expect(calls).toHaveLength(1);
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'])(
    'does not retry permanent network error %s',
    async (code) => {
      const { instance, calls } = transport([networkFailure(code)]);
      const error = await captureError(instance.call('core_webservice_get_site_info', {}));
      expect(error).toMatchObject({ code: 'network_error', networkCode: code, retryable: false });
      expect(calls).toHaveLength(1);
    },
  );

  it('does not retry Moodle exceptions such as an invalid token', async () => {
    const { instance, calls } = transport([
      json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }),
    ]);
    await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(calls).toHaveLength(1);
  });
});

describe('HttpMoodleTransport failure handling', () => {
  it('times out a slow request with a sanitized timeout error', async () => {
    const { instance } = transport([hang], { requestTimeoutMs: 20 });
    const error = await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(error).toBeInstanceOf(MoodleTransportError);
    expect(error).toMatchObject({ code: 'timeout', retryable: false });
  });

  it('reports caller cancellation', async () => {
    const controller = new AbortController();
    const { instance } = transport([hang]);
    const pending = instance.call(
      'core_webservice_get_site_info',
      {},
      { signal: controller.signal },
    );
    controller.abort();
    expect(await captureError(pending)).toMatchObject({ code: 'aborted' });
  });

  it('refuses to follow a redirect from the REST endpoint', async () => {
    const { instance, calls } = transport([
      status(302, { location: 'https://evil.example.test/collect' }),
    ]);
    const error = await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(error).toMatchObject({ code: 'unexpected_redirect', category: 'transport' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['invalidtoken', MoodleAuthenticationError],
    ['invalidtimedtoken', MoodleAuthenticationError],
    ['invalidiptoken', MoodleAuthenticationError],
    ['accessexception', MoodleAuthorizationError],
    ['nopermissions', MoodleAuthorizationError],
    ['requireloginerror', MoodleAuthorizationError],
    ['invalidparameter', MoodleValidationError],
    ['sitemaintenance', MoodleApiError],
    ['somethingnew', MoodleApiError],
  ])('maps a Moodle exception with errorcode %s inside HTTP 200', async (errorcode, errorType) => {
    const { instance } = transport([
      json({ exception: 'moodle_exception', errorcode, message: 'Something went wrong' }),
    ]);
    const error = await captureError(instance.call('core_webservice_get_site_info', {}));
    expect(error).toBeInstanceOf(errorType);
    expect(error).toMatchObject({
      moodleErrorCode: errorcode,
      functionName: 'core_webservice_get_site_info',
      retryable: false,
    });
  });

  it('recognises the legacy {error, errorcode} exception shape', async () => {
    const { instance } = transport([json({ error: 'Invalid token', errorcode: 'invalidtoken' })]);
    expect(await captureError(instance.call('core_webservice_get_site_info', {}))).toBeInstanceOf(
      MoodleAuthenticationError,
    );
  });

  it('does not treat ordinary data that mentions errors as an exception', async () => {
    const { instance } = transport([json({ warnings: [{ warningcode: 'x' }], errorcode: 5 })]);
    await expect(instance.call('core_webservice_get_site_info', {})).resolves.toBeDefined();
  });

  it('identifies an HTML page returned instead of JSON', async () => {
    const { instance } = transport([
      body('<html><body>Site maintenance</body></html>', { 'content-type': 'text/html' }),
    ]);
    expect(await captureError(instance.call('core_webservice_get_site_info', {}))).toMatchObject({
      code: 'unexpected_html_response',
      category: 'api',
    });
  });

  it('rejects malformed JSON', async () => {
    const { instance } = transport([body('{"sitename": ', { 'content-type': 'application/json' })]);
    expect(await captureError(instance.call('core_webservice_get_site_info', {}))).toMatchObject({
      code: 'invalid_json',
    });
  });

  it('enforces the response size limit', async () => {
    const { instance } = transport([json({ data: 'x'.repeat(2_000) })], {
      maxResponseBytes: 1_000,
    });
    expect(
      await captureError(instance.call('core_course_get_contents', { courseid: 1 })),
    ).toMatchObject({
      code: 'response_too_large',
    });
  });

  it('logs failures with parameter names only, never values', async () => {
    const { instance, logLines } = transport([status(400)]);
    await captureError(
      instance.call('core_user_get_users_by_field', {
        field: 'email',
        values: ['person@example.test'],
      }),
    );
    const log = logLines.join('\n');
    expect(log).toContain('"parameterNames":["field","values"]');
    expect(log).not.toContain('person@example.test');
    expect(log).not.toContain(FAKE_TOKEN);
  });
});
