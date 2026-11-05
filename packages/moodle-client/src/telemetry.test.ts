import { InMemoryTelemetry, resetTelemetry, setTelemetry } from '@ehub/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FAKE_TOKEN,
  baseUrl,
  body,
  captureError,
  fastRetryPolicy,
  json,
  memoryLogger,
  recordingSleep,
  scriptedFetch,
  status,
  type Handler,
} from './__fixtures__/fakeHttp.js';
import { HttpMoodleFileDownloader } from './downloader.js';
import { HttpMoodleTransport } from './transport.js';

const FILE_URL =
  'https://ehub.example.test/webservice/pluginfile.php/900/mod_resource/content/3/checklist.pdf';

let memory: InMemoryTelemetry;
beforeEach(() => {
  memory = new InMemoryTelemetry();
  setTelemetry(memory);
});
afterEach(() => {
  resetTelemetry();
});

function transport(...handlers: Handler[]) {
  return new HttpMoodleTransport({
    baseUrl,
    token: FAKE_TOKEN,
    requestTimeoutMs: 5_000,
    retryPolicy: fastRetryPolicy,
    fetch: scriptedFetch(...handlers).fetch,
    sleep: recordingSleep().sleep,
    random: () => 0.5,
    logger: memoryLogger().logger,
  });
}

function recorded(): string {
  return JSON.stringify({
    spans: memory.spans.map((span) => span.attributes),
    metrics: memory.metrics,
  });
}

describe('Moodle telemetry', () => {
  it('records a web-service call as a dependency named by function', async () => {
    await transport(json({ ok: true })).call('core_course_get_contents', { courseid: 7 });
    expect(memory.spans[0]).toMatchObject({
      name: 'moodle.request',
      kind: 'client',
      attributes: { 'ehub.dependency': 'moodle', 'ehub.operation': 'core_course_get_contents' },
      status: 'ok',
    });
    expect(
      memory.find('ehub.dependency.duration', { dependency: 'moodle', outcome: 'success' }),
    ).toHaveLength(1);
  });

  it('counts an invalid token as an authentication failure without recording the token', async () => {
    const error = await captureError(
      transport(
        json({
          exception: 'moodle_exception',
          errorcode: 'invalidtoken',
          message: 'Invalid token',
        }),
      ).call('core_webservice_get_site_info', {}),
    );
    expect(error).toBeDefined();
    expect(
      memory.sum('ehub.dependency.failures', { dependency: 'moodle', category: 'authentication' }),
    ).toBe(1);
    expect(memory.spans[0]).toMatchObject({ status: 'error', failureCategory: 'authentication' });
    expect(recorded()).not.toContain(FAKE_TOKEN);
  });

  it('counts exhausted 429s as a rate-limit event', async () => {
    const limited = status(429, { 'retry-after': '1' });
    await captureError(
      transport(limited, limited, limited, limited).call('core_webservice_get_site_info', {}),
    );
    expect(memory.find('ehub.rate_limit.events', { dependency: 'moodle' })).toHaveLength(1);
    expect(memory.sum('ehub.dependency.failures', { category: 'rate_limit' })).toBe(1);
  });

  it('records a download with its size, never its URL or token', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 fake');
    const downloader = new HttpMoodleFileDownloader({
      baseUrl,
      token: FAKE_TOKEN,
      downloadTimeoutMs: 5_000,
      maxDownloadBytes: 1_024,
      retryPolicy: fastRetryPolicy,
      fetch: scriptedFetch(body(bytes, { 'content-type': 'application/pdf' })).fetch,
      sleep: recordingSleep().sleep,
      random: () => 0.5,
    });
    await downloader.download(FILE_URL);
    expect(memory.spans[0]).toMatchObject({
      name: 'moodle.download',
      attributes: {
        'ehub.dependency': 'moodle_download',
        'ehub.operation': 'file',
        'ehub.count.bytes': bytes.byteLength,
      },
    });
    const text = recorded();
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain('pluginfile');
    expect(text).not.toContain('checklist');
  });
});
