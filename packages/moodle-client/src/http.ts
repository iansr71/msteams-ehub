import {
  MoodleApiError,
  MoodleAuthenticationError,
  MoodleAuthorizationError,
  MoodleRateLimitError,
  MoodleTransportError,
  MoodleValidationError,
  sanitizeErrorText,
  type MoodleError,
} from './errors.js';

/** The subset of `fetch` the client needs; injected so tests never reach a real server. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Network failures worth retrying: connection reset (including undici's "other side closed")
 * and temporary DNS failure. Permanent DNS failure (ENOTFOUND), refused connections and TLS
 * errors are configuration problems and are surfaced immediately.
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
]);

const MALFORMED_REQUEST_STATUSES: ReadonlySet<number> = new Set([
  400, 404, 405, 409, 411, 413, 414, 415, 422,
]);

export interface ErrorContext {
  readonly functionName?: string;
  readonly operation: 'request' | 'download';
}

function contextDetails(context: ErrorContext): { functionName?: string } {
  return context.functionName === undefined ? {} : { functionName: context.functionName };
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export function errorFromHttpStatus(
  status: number,
  context: ErrorContext,
  retryAfterMs?: number,
): MoodleError {
  const code = `http_${String(status)}`;
  const base = {
    code,
    httpStatus: status,
    ...contextDetails(context),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  const what = context.operation === 'download' ? 'File download' : 'Moodle request';

  if (status === 401) {
    return new MoodleAuthenticationError(
      `${what} was rejected as unauthenticated (HTTP 401).`,
      base,
    );
  }
  if (status === 403) {
    return new MoodleAuthorizationError(`${what} was forbidden (HTTP 403).`, base);
  }
  if (status === 429) {
    return new MoodleRateLimitError(`${what} was rate limited (HTTP 429).`, {
      ...base,
      retryable: true,
    });
  }
  if (isRetryableStatus(status)) {
    return new MoodleTransportError(`${what} failed with HTTP ${String(status)}.`, {
      ...base,
      retryable: true,
    });
  }
  if (MALFORMED_REQUEST_STATUSES.has(status)) {
    return new MoodleValidationError(`${what} was rejected (HTTP ${String(status)}).`, base);
  }
  return new MoodleApiError(`${what} failed with HTTP ${String(status)}.`, base);
}

function readCode(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = value.code;
    return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : undefined;
  }
  return undefined;
}

/** Finds a Node/undici network error code anywhere in an error's cause chain. */
export function findNetworkCode(error: unknown): string | undefined {
  const queue: unknown[] = [error];
  for (let inspected = 0; queue.length > 0 && inspected < 10; inspected += 1) {
    const current = queue.shift();
    const code = readCode(current);
    if (code !== undefined) {
      return code;
    }
    if (current instanceof AggregateError) {
      queue.push(...(current.errors as unknown[]));
    }
    if (current instanceof Error && current.cause !== undefined) {
      queue.push(current.cause);
    }
  }
  return undefined;
}

export interface RequestSignals {
  /** Combined signal to pass to fetch. */
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
}

export function createRequestSignals(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): RequestSignals {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal:
      callerSignal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, callerSignal]),
    timeoutSignal,
    callerSignal,
  };
}

/**
 * Converts anything thrown by fetch or body reading into a sanitized transport error. The
 * original error is deliberately discarded: undici messages can include the request URL.
 */
export function errorFromNetworkFailure(
  error: unknown,
  context: ErrorContext,
  signals: RequestSignals,
): MoodleError {
  const what = context.operation === 'download' ? 'File download' : 'Moodle request';
  if (signals.callerSignal?.aborted === true) {
    return new MoodleTransportError(`${what} was cancelled.`, {
      code: 'aborted',
      ...contextDetails(context),
    });
  }
  if (signals.timeoutSignal.aborted) {
    return new MoodleTransportError(`${what} timed out.`, {
      code: 'timeout',
      ...contextDetails(context),
    });
  }
  const networkCode = findNetworkCode(error);
  const retryable = networkCode !== undefined && RETRYABLE_NETWORK_CODES.has(networkCode);
  return new MoodleTransportError(
    `${what} failed with a network error (${networkCode ?? 'unknown'}).`,
    {
      code: retryable ? 'network_transient' : 'network_error',
      retryable,
      ...contextDetails(context),
      ...(networkCode === undefined ? {} : { networkCode }),
    },
  );
}

/**
 * Reads a response body without buffering more than `maxBytes`. Checks Content-Length up front
 * and enforces the limit while streaming, because Content-Length can be absent or wrong.
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  onLimitExceeded: () => MoodleError,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw onLimitExceeded();
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }

  // undici's stream types resolve to `any` under @types/node 20, so chunks are checked at runtime.
  const reader = response.body.getReader() as {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(): Promise<void>;
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const value = result.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      throw new MoodleTransportError('Response body contained unexpected data.', {
        code: 'invalid_body',
      });
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw onLimitExceeded();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const AUTHENTICATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalidtoken',
  'invalidtimedtoken',
  'invalidiptoken',
  'invalidtokensession',
  'servicerequireslogin',
  'usernotfullysetup',
  'forcepasswordchangenotice',
  'invalidlogin',
]);

const AUTHORIZATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'accessexception',
  'nopermissions',
  'requireloginerror',
  'servicenotavailable',
  'enablewsdescription',
  'webservicesnotenabled',
]);

const VALIDATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalidparameter',
  'missingparam',
  'invalidrecord',
  'invalidrecordunknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detects the exception object Moodle returns with HTTP 200, e.g.
 * `{"exception":"moodle_exception","errorcode":"invalidtoken","message":"Invalid token"}`.
 * `debuginfo` is never read: it can contain SQL, file paths and request values.
 */
export function moodleExceptionFromBody(
  body: unknown,
  context: ErrorContext,
  secrets: readonly string[],
): MoodleError | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const errorcode = body['errorcode'];
  const hasMarker = typeof body['exception'] === 'string' || typeof body['error'] === 'string';
  if (typeof errorcode !== 'string' || !hasMarker) {
    return undefined;
  }

  // errorcode is upstream data too: scrub secrets before reducing it to an identifier.
  let scrubbedCode = errorcode;
  for (const secret of secrets) {
    if (secret.length > 0) {
      scrubbedCode = scrubbedCode.split(secret).join('redacted');
    }
  }
  const moodleErrorCode = scrubbedCode.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || 'unknown';
  const rawMessage =
    typeof body['message'] === 'string'
      ? body['message']
      : typeof body['error'] === 'string'
        ? body['error']
        : 'Moodle returned an exception.';
  const message = `Moodle exception (${moodleErrorCode}): ${sanitizeErrorText(rawMessage, secrets)}`;
  const details = { code: moodleErrorCode, moodleErrorCode, ...contextDetails(context) };

  if (AUTHENTICATION_ERROR_CODES.has(moodleErrorCode)) {
    return new MoodleAuthenticationError(message, details);
  }
  if (AUTHORIZATION_ERROR_CODES.has(moodleErrorCode)) {
    return new MoodleAuthorizationError(message, details);
  }
  if (VALIDATION_ERROR_CODES.has(moodleErrorCode)) {
    return new MoodleValidationError(message, details);
  }
  return new MoodleApiError(message, details);
}
