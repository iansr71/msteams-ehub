import { describe, expect, it } from 'vitest';

import { DefaultMoodleClient } from '../../packages/moodle-client/src/client.js';
import { HttpMoodleTransport } from '../../packages/moodle-client/src/transport.js';
import { SUPPORTED_MOODLE_FUNCTIONS } from '../../packages/moodle-client/src/transport.js';
import {
  FAKE_TOKEN,
  baseUrl,
  captureError,
  fastRetryPolicy,
  json,
  memoryLogger,
  recordingSleep,
  scriptedFetch,
  status,
  type Handler,
} from '../../packages/moodle-client/src/__fixtures__/fakeHttp.js';

/*
 * Acceptance suite 01: can the assistant talk to Moodle, and does it behave correctly when it
 * cannot? Runs against a scripted HTTP transport, so it proves the client's own behaviour;
 * reaching the real E-Hub server is checked by `pnpm diagnose` against a deployment.
 */

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

const SITE_INFO = {
  sitename: 'E-Hub',
  username: 'ehub-service',
  userid: 7,
  functions: SUPPORTED_MOODLE_FUNCTIONS.map((name) => ({ name, version: '2026' })),
};

describe('01 Moodle connectivity', () => {
  it('reads site information over the web-service endpoint', async () => {
    const result = await transport(json(SITE_INFO)).call('core_webservice_get_site_info', {});
    expect(result).toMatchObject({ sitename: 'E-Hub', username: 'ehub-service' });
  });

  it('sends the token in the body, never in the URL', async () => {
    const script = scriptedFetch(json(SITE_INFO));
    const client = new HttpMoodleTransport({
      baseUrl,
      token: FAKE_TOKEN,
      requestTimeoutMs: 5_000,
      retryPolicy: fastRetryPolicy,
      fetch: script.fetch,
      sleep: recordingSleep().sleep,
      random: () => 0.5,
      logger: memoryLogger().logger,
    });
    await client.call('core_webservice_get_site_info', {});
    const [call] = script.calls;
    expect(call?.url).not.toContain(FAKE_TOKEN);
    const body = call?.init.body;
    expect(typeof body === 'string' ? body : '').toContain(FAKE_TOKEN);
  });

  it('reports a rejected token as an authentication failure, without echoing it', async () => {
    const error = await captureError(
      transport(
        json({
          exception: 'moodle_exception',
          errorcode: 'invalidtoken',
          message: 'Invalid token',
        }),
      ).call('core_webservice_get_site_info', {}),
    );
    expect(error).toMatchObject({ category: 'authentication', retryable: false });
    expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
  });

  it('gives up after retrying a throttled site, and says so', async () => {
    const limited = status(429, { 'retry-after': '1' });
    const error = await captureError(
      transport(limited, limited, limited, limited).call('core_webservice_get_site_info', {}),
    );
    expect(error).toMatchObject({ category: 'rate_limit' });
  });

  it('refuses a response that is not the documented shape', async () => {
    // Validation is the client's job, not the transport's: the transport returns raw JSON.
    const client = new DefaultMoodleClient(transport(json({ unexpected: true })));
    const error = await captureError(client.getCourses());
    expect(error).toMatchObject({ name: 'MoodleValidationError' });
  });

  it('calls only the functions the service account needs', () => {
    expect([...SUPPORTED_MOODLE_FUNCTIONS].sort()).toEqual(
      [
        'core_course_get_contents',
        'core_course_get_courses',
        'core_enrol_get_enrolled_users',
        'core_enrol_get_users_courses',
        'core_user_get_users_by_field',
        'core_webservice_get_site_info',
      ].sort(),
    );
  });
});
