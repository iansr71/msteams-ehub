import { inspect } from 'node:util';

import { clearRegisteredSecretValues } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FAKE_TOKEN,
  baseUrl,
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
import { HttpMoodleFileDownloader } from './downloader.js';
import { MoodleError } from './errors.js';
import { HttpMoodleTransport } from './transport.js';

/*
 * Forces every failure path with the token planted wherever an upstream system might echo it,
 * then checks every way an error or log line could be rendered. Registered-secret scrubbing
 * is cleared before each scenario runs so these tests prove the client's own sanitisation,
 * not just the global safety net.
 */

const FILE_URL =
  'https://ehub.example.test/webservice/pluginfile.php/900/mod_resource/content/3/a.pdf';
const TOKEN_URL = `https://ehub.example.test/webservice/rest/server.php?wstoken=${FAKE_TOKEN}`;

function renderings(error: unknown, logLines: readonly string[]): string[] {
  const asError = error as Error;
  return [
    String(error),
    asError.message,
    asError.stack ?? '',
    JSON.stringify(error),
    inspect(error, { depth: 10, showHidden: true }),
    ...logLines,
  ];
}

function expectNoToken(error: unknown, logLines: readonly string[]): void {
  expect(error).toBeInstanceOf(MoodleError);
  for (const rendering of renderings(error, logLines)) {
    expect(rendering).not.toContain(FAKE_TOKEN);
  }
  expect((error as Error).cause).toBeUndefined();
}

const leakyFailures: [string, Handler][] = [
  [
    'network error whose message contains the token URL',
    () => {
      throw new TypeError(`fetch failed for ${TOKEN_URL}`, {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${TOKEN_URL}`), {
          code: 'ECONNREFUSED',
        }),
      });
    },
  ],
  [
    'network error containing the bare token',
    () => {
      throw new TypeError(`fetch failed: bad header value ${FAKE_TOKEN}`, {
        cause: Object.assign(new Error(`invalid ${FAKE_TOKEN}`), { code: 'ERR_INVALID_CHAR' }),
      });
    },
  ],
  ['retried connection resets', networkFailure('ECONNRESET', `socket hang up ${TOKEN_URL}`)],
  ['retried resets with the bare token', networkFailure('ECONNRESET', `reset ${FAKE_TOKEN}`)],
  [
    'Moodle exception echoing the token in message and debuginfo',
    json({
      exception: 'moodle_exception',
      errorcode: 'invalidtoken',
      message: `Invalid token ${FAKE_TOKEN}`,
      debuginfo: `wstoken=${FAKE_TOKEN} SELECT * FROM mdl_external_tokens`,
    }),
  ],
  [
    'legacy error shape echoing the token',
    json({ error: `Token ${FAKE_TOKEN} expired`, errorcode: 'invalidtimedtoken' }),
  ],
  [
    'HTTP 500 with the token in the body',
    () => new Response(`error ${FAKE_TOKEN}`, { status: 500 }),
  ],
  [
    'HTML error page with the token',
    () => new Response(`<html>${TOKEN_URL}</html>`, { status: 200 }),
  ],
  [
    'invalid JSON containing the token',
    () => new Response(`{"x": "${FAKE_TOKEN}`, { status: 200 }),
  ],
  ['redirect to a URL carrying the token', status(302, { location: TOKEN_URL })],
];

afterEach(() => {
  clearRegisteredSecretValues();
});

describe('token redaction under forced transport and API failures', () => {
  it.each(leakyFailures)('REST call: %s', async (_label, handler) => {
    const log = memoryLogger();
    const transport = new HttpMoodleTransport({
      baseUrl,
      token: FAKE_TOKEN,
      requestTimeoutMs: 5_000,
      retryPolicy: fastRetryPolicy,
      fetch: scriptedFetch(handler, handler, handler, handler).fetch,
      sleep: recordingSleep().sleep,
      logger: log.logger,
    });
    clearRegisteredSecretValues();

    const error = await captureError(transport.call('core_webservice_get_site_info', {}));

    expectNoToken(error, log.lines);
  });

  it.each(leakyFailures)('file download: %s', async (_label, handler) => {
    const log = memoryLogger();
    const downloader = new HttpMoodleFileDownloader({
      baseUrl,
      token: FAKE_TOKEN,
      downloadTimeoutMs: 5_000,
      maxDownloadBytes: 1_024,
      retryPolicy: fastRetryPolicy,
      fetch: scriptedFetch(handler, handler, handler, handler).fetch,
      sleep: recordingSleep().sleep,
      logger: log.logger,
    });
    clearRegisteredSecretValues();

    const error = await captureError(downloader.download(FILE_URL)).catch(() => undefined);

    // An HTML or invalid-JSON body is a valid file download; only failures are inspected.
    if (error !== undefined) {
      expectNoToken(error, log.lines);
    }
    for (const line of log.lines) {
      expect(line).not.toContain(FAKE_TOKEN);
    }
  });

  it('timeouts and cancellations carry no token', async () => {
    const transport = new HttpMoodleTransport({
      baseUrl,
      token: FAKE_TOKEN,
      requestTimeoutMs: 10,
      fetch: scriptedFetch(hang).fetch,
    });
    clearRegisteredSecretValues();
    expectNoToken(await captureError(transport.call('core_webservice_get_site_info', {})), []);
  });

  it('keeps the token out of error JSON fields as well as messages', async () => {
    const transport = new HttpMoodleTransport({
      baseUrl,
      token: FAKE_TOKEN,
      requestTimeoutMs: 1_000,
      fetch: scriptedFetch(json({ exception: 'x', errorcode: `bad${FAKE_TOKEN}`, message: 'm' }))
        .fetch,
    });
    clearRegisteredSecretValues();
    const error = (await captureError(
      transport.call('core_webservice_get_site_info', {}),
    )) as MoodleError;
    expect(JSON.stringify(error.toJSON())).not.toContain(FAKE_TOKEN.slice(0, 20));
    // The error code is sanitized to Moodle's identifier alphabet and length-limited.
    expect(error.moodleErrorCode?.length).toBeLessThanOrEqual(64);
  });
});
