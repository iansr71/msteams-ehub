import { SearchServiceError, sanitizeServiceMessage, type SearchErrorCategory } from './errors.js';

/** The subset of `fetch` the client needs; injected so tests never reach a real service. */
export type SearchFetch = (input: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type RandomSource = () => number;

export interface SearchRetryPolicy {
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A Retry-After longer than this is not waited for; the error is surfaced instead. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_SEARCH_RETRY_POLICY: SearchRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 60_000,
};

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
  policy: SearchRetryPolicy,
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

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** Connection resets and temporary DNS failures; refused connections and TLS errors are not. */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

function categoryForStatus(status: number): SearchErrorCategory {
  switch (status) {
    case 401:
      return 'authentication';
    case 403:
      return 'authorization';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 412:
      return 'precondition_failed';
    case 413:
      return 'request_too_large';
    case 408:
      return 'timeout';
    case 429:
      return 'throttled';
    default:
      return status >= 500 ? 'unavailable' : 'invalid_request';
  }
}

export interface ServiceErrorBody {
  readonly code: string | undefined;
  readonly message: string | undefined;
}

export function parseServiceErrorBody(text: string): ServiceErrorBody {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error: unknown = parsed.error;
      if (typeof error === 'object' && error !== null) {
        const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        const message =
          'message' in error && typeof error.message === 'string' ? error.message : undefined;
        return { code, message };
      }
    }
  } catch {
    // Not JSON (e.g. a gateway error page); only the status is reported.
  }
  return { code: undefined, message: undefined };
}

export interface HttpErrorOptions {
  readonly operation: string;
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs: number | undefined;
  /**
   * Whether the service's message may be included. True only for index-management calls,
   * whose messages describe the schema; document and query errors can echo field values.
   */
  readonly includeServiceMessage: boolean;
}

export function errorFromHttpResponse(options: HttpErrorOptions): SearchServiceError {
  const { code, message } = parseServiceErrorBody(options.body);
  const suffix =
    options.includeServiceMessage && message !== undefined
      ? ` ${sanitizeServiceMessage(message, { keepQuotedIdentifiers: true })}`
      : '';
  const serviceCode = code === undefined ? '' : ` (${sanitizeServiceMessage(code)})`;
  return new SearchServiceError(
    `Azure AI Search ${options.operation} failed with HTTP ${String(options.status)}${serviceCode}.${suffix}`,
    {
      category: categoryForStatus(options.status),
      operation: options.operation,
      httpStatus: options.status,
      ...(code === undefined ? {} : { serviceCode: sanitizeServiceMessage(code) }),
      retryable: RETRYABLE_STATUSES.has(options.status),
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    },
  );
}

function networkCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function errorFromFetchFailure(
  error: unknown,
  operation: string,
  timedOut: boolean,
  callerAborted: boolean,
): SearchServiceError {
  if (callerAborted) {
    return new SearchServiceError(`Azure AI Search ${operation} was cancelled.`, {
      category: 'cancelled',
      operation,
    });
  }
  if (timedOut) {
    return new SearchServiceError(`Azure AI Search ${operation} timed out.`, {
      category: 'timeout',
      operation,
      retryable: true,
    });
  }
  const code = networkCode(error);
  return new SearchServiceError(
    `Azure AI Search ${operation} could not reach the service${code === undefined ? '' : ` (${code})`}.`,
    {
      category: 'network',
      operation,
      retryable: code !== undefined && RETRYABLE_NETWORK_CODES.has(code),
    },
  );
}

export async function readTextWithLimit(
  response: Response,
  maxBytes: number,
  operation: string,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SearchServiceError(`Azure AI Search ${operation} response is too large.`, {
      category: 'invalid_response',
      operation,
    });
  }
  if (response.body === null) {
    return '';
  }
  // undici's stream types resolve to `any` here, so chunks are checked at runtime.
  const reader = response.body.getReader() as {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(): Promise<void>;
  };
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const value = result.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      throw new SearchServiceError(`Azure AI Search ${operation} response could not be read.`, {
        category: 'invalid_response',
        operation,
      });
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SearchServiceError(`Azure AI Search ${operation} response is too large.`, {
        category: 'invalid_response',
        operation,
      });
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}
