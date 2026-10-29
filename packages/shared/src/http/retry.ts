/*
 * HTTP retry helpers shared by the Azure AI Search and Azure OpenAI clients.
 */

/** The subset of `fetch` the clients need; injected so tests never reach a real service. */
export type HttpFetch = (input: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type RandomSource = () => number;

export interface RetryPolicy {
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A Retry-After longer than this is not waited for; the error is surfaced instead. */
  readonly maxRetryAfterMs: number;
}

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Full-jitter exponential backoff, honouring a server-requested delay when it is longer. */
export function retryDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: RandomSource,
): number | undefined {
  const backoff = Math.floor(
    random() * Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt),
  );
  if (retryAfterMs === undefined) {
    return backoff;
  }
  return retryAfterMs > policy.maxRetryAfterMs ? undefined : Math.max(retryAfterMs, backoff);
}

/** Reads `retry-after-ms`, `x-ms-retry-after-ms` or `Retry-After` (seconds or HTTP date). */
export function parseRetryAfterHeaders(
  headers: Headers,
  now: number = Date.now(),
): number | undefined {
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && /^\d+$/.test(value)) {
      return Number(value);
    }
  }
  const value = headers.get('retry-after')?.trim();
  if (value === undefined) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = /[a-z]/i.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** HTTP statuses worth retrying: timeouts, throttling and transient server errors. */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** Connection resets and temporary DNS failures; refused connections and TLS errors are not. */
export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

/** The first `code` found on an error or its causes (undici wraps socket errors). */
export function networkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
