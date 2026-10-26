import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMoodleServices, type MoodleServices } from '@ehub/moodle-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Exercises the client with Node's real fetch (undici) against a local HTTP server that
 * imitates Moodle. Unit tests use a fake fetch; this verifies the assumptions they encode:
 * form encoding, manual redirects, network error codes and streaming limits.
 */

const TOKEN = 'integrationfaketoken0123456789abcdef';

interface Seen {
  method: string;
  path: string;
  body: string;
}

const seen: Seen[] = [];
let server: Server;
let baseUrl: string;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  const url = new URL(request.url ?? '/', 'http://localhost');
  seen.push({ method: request.method ?? '', path: url.pathname + url.search, body });

  if (url.pathname === '/webservice/rest/server.php') {
    const form = new URLSearchParams(body);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (form.get('wstoken') !== TOKEN) {
      response.end(
        JSON.stringify({
          exception: 'moodle_exception',
          errorcode: 'invalidtoken',
          message: 'Invalid token',
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        sitename: 'Local Moodle',
        username: 'svc',
        userid: 2,
        siteurl: baseUrl,
        functions: [{ name: form.get('wsfunction') ?? '', version: '1' }],
      }),
    );
    return;
  }
  if (url.pathname === '/webservice/pluginfile.php/1/mod_resource/content/1/redirect.pdf') {
    response.writeHead(302, { location: 'https://elsewhere.example.test/steal' }).end();
    return;
  }
  if (url.pathname === '/webservice/pluginfile.php/1/mod_resource/content/1/big.bin') {
    // No Content-Length: the limit must be enforced while streaming.
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write(Buffer.alloc(4096));
    response.end(Buffer.alloc(4096));
    return;
  }
  if (url.pathname.startsWith('/webservice/pluginfile.php/')) {
    response.writeHead(200, { 'content-type': 'application/pdf' });
    response.end(url.searchParams.get('token') === TOKEN ? '%PDF-1.7 ok' : 'denied');
    return;
  }
  response.writeHead(404).end();
}

function services(
  token = TOKEN,
  overrides: { base?: string; maxDownloadBytes?: number } = {},
): MoodleServices {
  return createMoodleServices(
    {
      baseUrl: overrides.base ?? baseUrl,
      token,
      requestTimeoutMs: 5_000,
      downloadTimeoutMs: 5_000,
      maxDownloadBytes: overrides.maxDownloadBytes ?? 1_000_000,
      maxRetries: 0,
      allowHttp: true,
    },
    {},
  );
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

describe('Moodle client over real HTTP', () => {
  it('sends the token in the POST body and validates the response', async () => {
    const info = await services().client.getSiteInfo();
    expect(info.sitename).toBe('Local Moodle');
    const request = seen.at(-1)!;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/webservice/rest/server.php');
    expect(request.path).not.toContain(TOKEN);
    expect(new URLSearchParams(request.body).get('wsfunction')).toBe(
      'core_webservice_get_site_info',
    );
  });

  it('maps an invalid-token exception returned with HTTP 200', async () => {
    await expect(services('wrongtoken0123456789xyz').client.getSiteInfo()).rejects.toMatchObject({
      category: 'authentication',
      moodleErrorCode: 'invalidtoken',
    });
  });

  it('downloads a pluginfile with the token on the request only', async () => {
    const url = `${baseUrl}/pluginfile.php/1/mod_resource/content/1/doc.pdf`;
    const file = await services().downloader.download(url);
    expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.7 ok');
    expect(file.sourceUrl).toBe(url);
    expect(seen.at(-1)!.path).toContain(
      '/webservice/pluginfile.php/1/mod_resource/content/1/doc.pdf',
    );
  });

  it('sees the real 302 under redirect: manual and blocks the unapproved host', async () => {
    const before = seen.length;
    await expect(
      services().downloader.download(
        `${baseUrl}/webservice/pluginfile.php/1/mod_resource/content/1/redirect.pdf`,
      ),
    ).rejects.toMatchObject({ code: 'unsafe_redirect' });
    expect(seen.length - before).toBe(1);
  });

  it('enforces the size limit on a streamed body without Content-Length', async () => {
    await expect(
      services(TOKEN, { maxDownloadBytes: 5_000 }).downloader.download(
        `${baseUrl}/webservice/pluginfile.php/1/mod_resource/content/1/big.bin`,
      ),
    ).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('reports a refused connection with a sanitized network code', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) =>
      closed.close(() => {
        resolve();
      }),
    );

    const error: unknown = await services(TOKEN, { base: `http://127.0.0.1:${String(port)}` })
      .client.getSiteInfo()
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      category: 'transport',
      networkCode: 'ECONNREFUSED',
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});
