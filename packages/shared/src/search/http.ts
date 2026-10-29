import {
  RETRYABLE_HTTP_STATUSES,
  RETRYABLE_NETWORK_CODES,
  networkCode,
  type HttpFetch,
  type RetryPolicy,
} from '../http/retry.js';
import { SearchServiceError, sanitizeServiceMessage, type SearchErrorCategory } from './errors.js';

export {
  defaultSleep,
  parseRetryAfterHeaders,
  retryDelay,
  type RandomSource,
  type Sleep,
} from '../http/retry.js';

/** The subset of `fetch` the client needs; injected so tests never reach a real service. */
export type SearchFetch = HttpFetch;
export type SearchRetryPolicy = RetryPolicy;

export const DEFAULT_SEARCH_RETRY_POLICY: SearchRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 60_000,
};

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
      retryable: RETRYABLE_HTTP_STATUSES.has(options.status),
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    },
  );
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
