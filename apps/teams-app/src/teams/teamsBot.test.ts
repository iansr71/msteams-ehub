import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLogger } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { answer } from '../cards/__fixtures__/answers.js';
import {
  PRODUCTION_BLOCKED_MESSAGE,
  TeamsStartupError,
  startTeamsServer,
  type RunningTeamsServer,
} from '../server.js';
import { RecentActivities, sdkLogger } from './teamsAdapter.js';

/*
 * The real Teams SDK app on the node:http adapter. Activities are posted to /api/messages the
 * way Bot Framework delivers them; replies go to the activity's serviceUrl, which points at a
 * local imitation of the Bot Connector service.
 */

interface ConnectorActivity {
  readonly type: string;
  readonly attachments?: {
    contentType: string;
    content: { body: unknown[]; actions?: unknown[] };
  }[];
}

let connector: Server | undefined;
let connectorUrl: string;
const posted: ConnectorActivity[] = [];
const running: RunningTeamsServer[] = [];
const apiCalls: { url: string; headers: Record<string, string>; body: unknown }[] = [];

async function startConnector(): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (
        request.method === 'POST' &&
        /\/v3\/conversations\/[^/]+\/activities/.test(request.url ?? '')
      ) {
        posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ConnectorActivity);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `sent-${String(posted.length)}` }));
    });
  });
  connector = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  connectorUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.stop();
  }
  const server = connector;
  connector = undefined;
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }
  posted.length = 0;
  apiCalls.length = 0;
});

const logs: string[] = [];
const logger = createLogger({
  service: 'test',
  level: 'trace',
  sink: { write: (line) => logs.push(line) },
});

const devEnv = {
  NODE_ENV: 'development',
  TEAMS_DEV_ALLOW_UNAUTHENTICATED: 'true',
  TEAMS_DEV_MOCK_IDENTITY: 'true',
  TEAMS_API_BASE_URL: 'http://answers.local',
};

async function start(env: Record<string, string> = devEnv): Promise<RunningTeamsServer> {
  await startConnector();
  const server = await startTeamsServer({
    env,
    logger,
    host: '127.0.0.1',
    port: 0,
    fetch: (url, init) => {
      apiCalls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string),
      });
      return Promise.resolve(
        url.endsWith('/v1/feedback')
          ? Response.json({ status: 'recorded' }, { status: 202 })
          : Response.json(answer({ mockIdentity: true })),
      );
    },
  });
  running.push(server);
  return server;
}

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id: `act-${String(Math.random()).slice(2)}`,
    channelId: 'msteams',
    serviceUrl: connectorUrl,
    from: {
      id: '29:user',
      aadObjectId: '00000000-0000-4000-8000-00000000beef',
      name: 'Mallory Admin',
    },
    recipient: { id: '28:bot', name: 'E-Hub' },
    conversation: {
      id: 'a:conv-1',
      conversationType: 'personal',
      tenantId: '00000000-0000-4000-8000-000000000001',
    },
    channelData: { tenant: { id: '00000000-0000-4000-8000-000000000001' } },
    locale: 'en-ZA',
    text: 'Zebra-orchid question about peel aftercare?',
    ...overrides,
  };
}

interface Delivered {
  readonly status: number;
  json(): Promise<unknown>;
}

/** A fresh connection per request: servers on reused ports must not see pooled sockets. */
function deliver(server: RunningTeamsServer, body: unknown): Promise<Delivered> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path: '/api/messages',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            json: () => Promise.resolve(JSON.parse(text) as unknown),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

async function settle(server: RunningTeamsServer): Promise<void> {
  await server.bot.tasks.idle();
}

function cardText(entry: ConnectorActivity | undefined): string {
  return JSON.stringify(entry?.attachments?.[0]?.content ?? {});
}

describe('Teams bot over HTTP', () => {
  it('serves /health', async () => {
    const server = await start();
    const health = await fetch(`http://127.0.0.1:${String(server.port)}/health`);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      service: 'ehub-teams-app',
      identityMode: 'dev-mock',
      inFlightQuestions: 0,
    });
    expect(
      (await fetch(`http://127.0.0.1:${String(server.port)}/health`, { method: 'POST' })).status,
    ).toBe(405);
  });

  it('welcomes on install', async () => {
    const server = await start();
    const response = await deliver(
      server,
      activity({ type: 'installationUpdate', action: 'add', text: undefined }),
    );
    expect(response.status).toBe(200);
    await settle(server);
    expect(cardText(posted.at(-1))).toContain('E-Hub Knowledge Assistant');
  });

  it('acknowledges a question at once, then posts typing and the answer card', async () => {
    const server = await start();
    const response = await deliver(server, activity());
    expect(response.status).toBe(200);
    await settle(server);
    expect(posted.map((entry) => entry.type)).toEqual(['typing', 'message']);
    expect(posted[1]?.attachments?.[0]?.contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
    expect(cardText(posted[1])).toContain('Sun protection after peels');
    expect(cardText(posted[1])).toContain('Development mode');
    // The Teams sender is not treated as identity: only the mock identity reaches the API.
    expect(apiCalls[0]?.headers['x-ehub-mock-identity']).toBe('dev-mock-user');
    expect(JSON.stringify(apiCalls[0])).not.toContain('beef');
    expect(JSON.stringify(apiCalls[0])).not.toContain('Mallory');
    const correlationId = apiCalls[0]?.headers['x-correlation-id'] ?? '';
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      logs.some(
        (line) =>
          line.includes(`"correlationId":"${correlationId}"`) && line.includes('Answer sent.'),
      ),
    ).toBe(true);
    expect(logs.join('\n')).not.toContain('Zebra-orchid');
  });

  it('handles a redelivered activity once', async () => {
    const server = await start();
    const first = activity({ id: 'same-id' });
    await deliver(server, first);
    await deliver(server, first);
    await settle(server);
    expect(apiCalls).toHaveLength(1);
  });

  it('answers group chats and channels with the personal-only card', async () => {
    const server = await start();
    await deliver(
      server,
      activity({ conversation: { id: '19:group', conversationType: 'groupChat' } }),
    );
    await settle(server);
    expect(cardText(posted.at(-1))).toContain('Personal chat only');
    expect(apiCalls).toHaveLength(0);
  });

  it('answers feedback buttons in the invoke response', async () => {
    const server = await start();
    const response = await deliver(
      server,
      activity({
        type: 'invoke',
        name: 'adaptiveCard/action',
        text: undefined,
        value: {
          action: {
            type: 'Action.Execute',
            verb: 'ehub.feedback',
            data: { ehubAction: 'feedback', answerId: 'answer-123', rating: 'useful' },
          },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      statusCode: 200,
      type: 'application/vnd.microsoft.activity.message',
      value: 'Thanks — your feedback was recorded.',
    });
    expect(apiCalls[0]?.url).toBe('http://answers.local/v1/feedback');
  });

  it('asks again from the retry button after answering the invoke', async () => {
    const server = await start();
    const response = await deliver(
      server,
      activity({
        type: 'invoke',
        name: 'adaptiveCard/action',
        text: undefined,
        value: {
          action: {
            type: 'Action.Execute',
            verb: 'ehub.retry',
            data: { ehubAction: 'retry', question: 'Again?' },
          },
        },
      }),
    );
    expect(((await response.json()) as { value: string }).value).toBe('Asking again…');
    await settle(server);
    expect(apiCalls[0]?.body).toEqual({ question: 'Again?' });
    expect(posted.at(-1)?.type).toBe('message');
  });

  it('refuses identity-less questions when the mock identity is off', async () => {
    const server = await start({
      NODE_ENV: 'development',
      TEAMS_DEV_ALLOW_UNAUTHENTICATED: 'true',
    });
    await deliver(server, activity());
    await settle(server);
    expect(cardText(posted.at(-1))).toContain('Sign-in is not available yet');
    expect(apiCalls).toHaveLength(0);
    const health = (await (
      await fetch(`http://127.0.0.1:${String(server.port)}/health`)
    ).json()) as { status: string };
    expect(health.status).toBe('degraded');
  });

  it('rejects unsigned requests when bot credentials are configured', async () => {
    const server = await start({
      NODE_ENV: 'development',
      TEAMS_BOT_CLIENT_ID: '00000000-0000-4000-8000-0000000000b0',
      TEAMS_BOT_CLIENT_SECRET: 'local-dev-secret-value',
      TEAMS_DEV_MOCK_IDENTITY: 'true',
    });
    const response = await deliver(server, activity());
    expect(response.status).toBe(401);
    await settle(server);
    expect(apiCalls).toHaveLength(0);
    expect(logs.join('\n')).not.toContain('local-dev-secret-value');
  });

  it('refuses to start in production, or with no way to verify requests', async () => {
    await expect(
      startTeamsServer({ env: { NODE_ENV: 'production' }, logger, port: 0 }),
    ).rejects.toThrow(PRODUCTION_BLOCKED_MESSAGE);
    await expect(
      startTeamsServer({ env: { NODE_ENV: 'development' }, logger, port: 0 }),
    ).rejects.toBeInstanceOf(TeamsStartupError);
    await expect(
      startTeamsServer({
        env: {
          NODE_ENV: 'test',
          TEAMS_DEV_MOCK_IDENTITY: 'true',
          TEAMS_DEV_ALLOW_UNAUTHENTICATED: 'true',
        },
        logger,
        port: 0,
      }),
    ).rejects.toThrow(/TEAMS_DEV_/);
  });
});

describe('adapter helpers', () => {
  it('remembers activity IDs for a while', () => {
    let now = 0;
    const recent = new RecentActivities(1_000, 3, () => now);
    expect(recent.firstTime('a')).toBe(true);
    expect(recent.firstTime('a')).toBe(false);
    expect(recent.firstTime(undefined)).toBe(true);
    now = 2_000;
    expect(recent.firstTime('a')).toBe(true);
  });

  it('keeps only the SDK message string, never activity payloads', () => {
    const lines: string[] = [];
    const log = sdkLogger(
      createLogger({
        service: 'test',
        level: 'trace',
        sink: { write: (line) => lines.push(line) },
      }),
    );
    log.debug('Handling activity', { text: 'secret question', from: { name: 'Mallory' } });
    log.error('JWT validation failed', new Error('token abc'));
    log.child('http').info('ready');
    const text = lines.join('\n');
    expect(text).toContain('Handling activity');
    expect(text).not.toContain('secret question');
    expect(text).not.toContain('Mallory');
    expect(text).toContain('"errorName":"Error"');
    expect(text).not.toContain('token abc');
  });
});
