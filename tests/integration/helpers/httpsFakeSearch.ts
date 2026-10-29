import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeSearchService } from '../../../packages/shared/src/search/__fixtures__/fakeSearchService.js';

export interface HttpsFakeSearch {
  readonly service: FakeSearchService;
  readonly endpoint: string;
  /** Trust this certificate in child processes through NODE_EXTRA_CA_CERTS. */
  readonly certFile: string;
  readonly workDir: string;
  close(): Promise<void>;
}

/**
 * Serves a FakeSearchService over HTTPS with a throwaway self-signed certificate, because the
 * search endpoint must be https even in tests.
 */
export async function startHttpsFakeSearch(apiKey: string): Promise<HttpsFakeSearch> {
  const workDir = mkdtempSync(join(tmpdir(), 'ehub-fake-search-'));
  const certFile = join(workDir, 'cert.pem');
  const keyFile = join(workDir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdio: 'ignore' },
  );
  const service = new FakeSearchService({ apiKey });
  const server: Server = createServer(
    { cert: readFileSync(certFile), key: readFileSync(keyFile) },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'https://127.0.0.1');
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') {
            headers[name] = value;
          }
        }
        const result = service.handle({
          method: request.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(result.status, result.headers ?? {});
        response.end(result.body ?? '');
      });
    },
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    service,
    endpoint: `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    certFile,
    workDir,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) =>
        server.close(() => {
          done();
        }),
      );
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
