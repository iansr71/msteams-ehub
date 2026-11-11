import { InMemoryTelemetry, createLogger, resetTelemetry, setTelemetry } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeHttpAdapter, type BotReadiness } from './httpAdapter.js';

const adapters: NodeHttpAdapter[] = [];
afterEach(async () => {
  resetTelemetry();
  for (const adapter of adapters.splice(0)) {
    await adapter.stop();
  }
});

async function start(ready?: () => Promise<BotReadiness>, status = 200) {
  const adapter = new NodeHttpAdapter({
    logger: createLogger({ service: 'test', level: 'silent' }),
    health: () => ({
      status: 'ok',
      service: 'ehub-teams-app',
      version: '0.1.0',
      identityMode: 'dev-mock',
      inFlightQuestions: 0,
    }),
    ...(ready === undefined ? {} : { ready }),
    host: '127.0.0.1',
  });
  adapter.registerRoute('POST', '/api/messages', () =>
    Promise.resolve({ status, body: { ok: true } }),
  );
  await adapter.start(0);
  adapters.push(adapter);
  return `http://127.0.0.1:${String(adapter.port)}`;
}

const SECRET_TEXT = 'my client has a rash, what now?';

describe('bot health endpoints', () => {
  it('answers liveness without checking the answer API', async () => {
    let probed = 0;
    const url = await start(() => {
      probed += 1;
      return Promise.resolve({ status: 'not_ready', dependencies: [] });
    });
    const response = await fetch(`${url}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'live' });
    expect(probed).toBe(0);
    expect((await fetch(`${url}/health/live`, { method: 'POST' })).status).toBe(405);
  });

  it('reports readiness from the answer API probe', async () => {
    let readiness: BotReadiness = {
      status: 'ready',
      dependencies: [{ name: 'answer_api', status: 'up', latencyMs: 2, category: null }],
    };
    const url = await start(() => Promise.resolve(readiness));
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    readiness = {
      status: 'not_ready',
      dependencies: [{ name: 'answer_api', status: 'down', latencyMs: 3_000, category: 'timeout' }],
    };
    const down = await fetch(`${url}/health/ready`);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual(readiness);
  });
});

describe('bot request telemetry', () => {
  it('records the activity span and duration without activity content', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const url = await start();
    await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer eyJhbGciOi.secret' },
      body: JSON.stringify({ type: 'message', text: SECRET_TEXT }),
    });
    expect(memory.spans).toEqual([
      expect.objectContaining({
        name: 'teams.activity',
        kind: 'server',
        attributes: {
          'ehub.service': 'teams',
          'http.request.method': 'POST',
          'http.response.status_code': 200,
        },
      }),
    ]);
    expect(
      memory.find('ehub.http.server.duration', {
        service: 'teams',
        route: 'teams_messages',
        status_class: '2xx',
      }),
    ).toHaveLength(1);
    const recorded = JSON.stringify([memory.spans.map((s) => s.attributes), memory.metrics]);
    expect(recorded).not.toContain(SECRET_TEXT);
    expect(recorded).not.toContain('eyJ');
  });

  it('counts a refused Bot Framework token as an access denial', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const url = await start(undefined, 401);
    await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(memory.sum('ehub.access.denials', { kind: 'bot_request_unauthenticated' })).toBe(1);
  });
});

describe('bot response headers', () => {
  it('sends strict headers and grants no other origin access', async () => {
    const url = await start();
    for (const response of [
      await fetch(`${url}/health/live`),
      await fetch(`${url}/nope`),
      await fetch(`${url}/api/messages`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      }),
    ]) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers.get('strict-transport-security')).toMatch(/^max-age=31536000/);
      for (const [name] of response.headers) {
        expect(name.startsWith('access-control-')).toBe(false);
      }
    }
  });
});
