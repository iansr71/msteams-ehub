import { redactString } from '@ehub/shared';

export type MoodleErrorCategory =
  'authentication' | 'authorization' | 'rate_limit' | 'validation' | 'transport' | 'api';

export interface MoodleErrorDetails {
  /** Stable, machine-readable reason, e.g. `invalid_token`, `timeout`, `unsafe_redirect`. */
  readonly code: string;
  readonly retryable?: boolean;
  readonly httpStatus?: number;
  /** Moodle's own `errorcode`, when Moodle returned an exception. */
  readonly moodleErrorCode?: string;
  /** Web-service function being called, when applicable. */
  readonly functionName?: string;
  /** Network error code (e.g. `ECONNRESET`), never the underlying error object. */
  readonly networkCode?: string;
  /** Suggested delay from a Retry-After header, in milliseconds. */
  readonly retryAfterMs?: number;
  /** Zod issue paths for response-validation failures. Paths only, never values. */
  readonly issuePaths?: readonly string[];
}

const MAX_MESSAGE_LENGTH = 300;

/**
 * Removes anything secret-shaped and bounds the length. Moodle exception messages and debug
 * output can echo request data, so every message passes through here before it is stored.
 */
export function sanitizeErrorText(text: string, extraSecrets: readonly string[] = []): string {
  let output = text;
  for (const secret of extraSecrets) {
    if (secret.length > 0) {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  output = redactString(output).replace(/\s+/g, ' ').trim();
  return output.length > MAX_MESSAGE_LENGTH ? `${output.slice(0, MAX_MESSAGE_LENGTH)}…` : output;
}

/**
 * Base class for all Moodle client errors. Errors never carry a `cause`: underlying
 * network or parser errors can contain request URLs (and therefore tokens), so only a
 * sanitized message and structured fields are kept.
 */
export abstract class MoodleError extends Error {
  abstract readonly category: MoodleErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly moodleErrorCode: string | undefined;
  readonly functionName: string | undefined;
  readonly networkCode: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly issuePaths: readonly string[] | undefined;

  constructor(message: string, details: MoodleErrorDetails) {
    super(sanitizeErrorText(message));
    this.name = new.target.name;
    this.code = details.code;
    this.retryable = details.retryable ?? false;
    this.httpStatus = details.httpStatus;
    this.moodleErrorCode = details.moodleErrorCode;
    this.functionName = details.functionName;
    this.networkCode = details.networkCode;
    this.retryAfterMs = details.retryAfterMs;
    this.issuePaths = details.issuePaths;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      moodleErrorCode: this.moodleErrorCode,
      functionName: this.functionName,
      networkCode: this.networkCode,
      retryAfterMs: this.retryAfterMs,
      issuePaths: this.issuePaths,
    };
  }
}

/** Token missing, invalid, expired or IP-restricted. Never retried. */
export class MoodleAuthenticationError extends MoodleError {
  readonly category = 'authentication' as const;
}

/** Token valid, but the service or user lacks access to the function or data. Never retried. */
export class MoodleAuthorizationError extends MoodleError {
  readonly category = 'authorization' as const;
}

/** HTTP 429 (usually from a proxy or WAF in front of Moodle). Retried with backoff. */
export class MoodleRateLimitError extends MoodleError {
  readonly category = 'rate_limit' as const;
}

/**
 * Data failed validation: the request was rejected as malformed (`invalidparameter`, HTTP 400)
 * or Moodle's response did not match the expected schema. Never retried.
 */
export class MoodleValidationError extends MoodleError {
  readonly category = 'validation' as const;
}

/** Network failure, timeout, unexpected redirect or transient HTTP status. */
export class MoodleTransportError extends MoodleError {
  readonly category = 'transport' as const;
}

/** Moodle returned an exception or response the client does not otherwise classify. */
export class MoodleApiError extends MoodleError {
  readonly category = 'api' as const;
}

export function isMoodleError(error: unknown): error is MoodleError {
  return error instanceof MoodleError;
}
