import { createLogger, type Logger } from '@ehub/shared';

import { normalizeMoodleBaseUrl, type NormalizedMoodleBaseUrl } from '../baseUrl.js';
import type { FetchFn } from '../http.js';
import type { RetryPolicy, Sleep } from '../retry.js';

/** Obviously fake; long enough to pass configuration validation. */
export const FAKE_TOKEN = 'faketoken0do0not0use0abcdef1234567';
export const BASE_URL = 'https://ehub.example.test';

export const baseUrl: NormalizedMoodleBaseUrl = normalizeMoodleBaseUrl(BASE_URL, {
  allowHttp: false,
});

export const fastRetryPolicy: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  maxRetryAfterMs: 5_000,
};

export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
  /** Decoded form body for POST requests. */
  readonly form: URLSearchParams | undefined;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

/**
 * A fetch double that answers each call with the next scripted handler and records the
 * request. Any call beyond the script fails the test loudly.
 */
export function scriptedFetch(...handlers: Handler[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...handlers];
  const fetch: FetchFn = async (url, init) => {
    const form = typeof init.body === 'string' ? new URLSearchParams(init.body) : undefined;
    const call: RecordedCall = { url, init, form };
    calls.push(call);
    const handler = queue.shift();
    if (handler === undefined) {
      throw new Error(`Unexpected extra HTTP call #${String(calls.length)}`);
    }
    return handler(call);
  };
  return { fetch, calls };
}

export function json(body: unknown, init: ResponseInit = {}): Handler {
  return () => {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json; charset=utf-8');
    }
    return new Response(JSON.stringify(body), { status: 200, ...init, headers });
  };
}

export function status(code: number, headers: Record<string, string> = {}): Handler {
  return () => new Response(code >= 300 && code < 400 ? null : 'error', { status: code, headers });
}

export function body(content: string | Uint8Array, headers: Record<string, string> = {}): Handler {
  return () => new Response(content, { status: 200, headers });
}

/** Simulates an undici network failure: `TypeError('fetch failed')` with a coded cause. */
export function networkFailure(code: string, causeMessage = `connect ${code}`): Handler {
  return () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error(causeMessage), { code }),
    });
  };
}

/** Never resolves until the request signal aborts, then rejects like fetch does. */
export const hang: Handler = ({ init }) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    });
  });

export function recordingSleep(): { sleep: Sleep; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

export function memoryLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      service: 'moodle-client-test',
      level: 'trace',
      sink: { write: (line) => lines.push(line) },
    }),
  };
}

export async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}
