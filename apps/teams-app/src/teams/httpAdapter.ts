import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from '@ehub/shared';
import type { HttpMethod, HttpRouteHandler, IHttpServerAdapter } from '@microsoft/teams.apps';

/** Teams activities are small; this bounds memory per request. */
export const MAX_ACTIVITY_BYTES = 1024 * 1024;

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly service: string;
  readonly version: string;
  readonly identityMode: 'entra-sso' | 'dev-mock' | 'none';
  readonly inFlightQuestions: number;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

class RequestTooLargeError extends Error {}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_ACTIVITY_BYTES) {
      throw new RequestTooLargeError();
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function headersOf(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * The SDK's HTTP transport on node:http, so the bot needs no web framework of its own. It
 * serves the SDK's routes (the Teams messaging endpoint, POST) and `GET /health`. The SDK
 * validates the Bot Framework token on the messaging endpoint; nothing here inspects it.
 */
export class NodeHttpAdapter implements IHttpServerAdapter {
  readonly #routes = new Map<string, HttpRouteHandler>();
  readonly #logger: Logger;
  readonly #health: () => HealthReport;
  readonly #host: string;
  #server: Server | undefined;

  constructor(options: {
    readonly logger: Logger;
    readonly health: () => HealthReport;
    readonly host?: string;
  }) {
    this.#logger = options.logger.child({ component: 'bot-http' });
    this.#health = options.health;
    this.#host = options.host ?? '0.0.0.0';
  }

  registerRoute(method: HttpMethod, path: string, handler: HttpRouteHandler): void {
    this.#routes.set(`${method} ${path}`, handler);
  }

  /** For tests: the request handler without a listening socket. */
  readonly handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const method = request.method ?? 'GET';
    try {
      if (path === '/health') {
        if (method !== 'GET') {
          respond(response, 405, { error: 'method_not_allowed' });
          return;
        }
        respond(response, 200, this.#health());
        return;
      }
      const route = this.#routes.get(`${method} ${path}`);
      if (route === undefined) {
        respond(response, 404, { error: 'not_found' });
        request.resume();
        return;
      }
      const contentType = (request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        respond(response, 415, { error: 'unsupported_media_type' });
        request.resume();
        return;
      }
      let body: unknown;
      try {
        body = await readBody(request);
      } catch (error) {
        respond(response, error instanceof RequestTooLargeError ? 413 : 400, {
          error: 'invalid_request',
        });
        request.resume();
        return;
      }
      const result = await route({ body, headers: headersOf(request) });
      respond(response, result.status, result.body);
    } catch (error) {
      this.#logger.error('Bot request failed.', { path, err: error });
      if (!response.headersSent) {
        respond(response, 500, { error: 'internal_error' });
      }
    }
  };

  async start(port: number | string): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), this.#host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    const address = server.address() as AddressInfo;
    this.#logger.info('Bot listening.', { port: address.port });
  }

  get port(): number | undefined {
    const address = this.#server?.address();
    return typeof address === 'object' && address !== null ? address.port : undefined;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    this.#server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
