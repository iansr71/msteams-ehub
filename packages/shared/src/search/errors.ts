import { redactString } from '../logging/redaction.js';

export const SEARCH_ERROR_CATEGORIES = [
  'authentication',
  'authorization',
  'not_found',
  'conflict',
  'precondition_failed',
  'request_too_large',
  'throttled',
  'unavailable',
  'timeout',
  'network',
  'cancelled',
  'invalid_request',
  'invalid_response',
  'access_denied',
] as const;
export type SearchErrorCategory = (typeof SEARCH_ERROR_CATEGORIES)[number];

export interface SearchErrorDetails {
  readonly category: SearchErrorCategory;
  /** Which client operation failed, e.g. `createIndex` or `indexDocuments`. */
  readonly operation: string;
  readonly httpStatus?: number;
  /** Azure's machine-readable error code, when the response carried one. */
  readonly serviceCode?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

/**
 * Every failure from the search client. Messages are built from the operation, HTTP status
 * and Azure error code only; credentials, request headers, document contents and query text
 * never appear in them.
 */
export class SearchServiceError extends Error {
  readonly category: SearchErrorCategory;
  readonly operation: string;
  readonly httpStatus: number | undefined;
  readonly serviceCode: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, details: SearchErrorDetails) {
    super(redactString(message));
    this.name = 'SearchServiceError';
    this.category = details.category;
    this.operation = details.operation;
    this.httpStatus = details.httpStatus;
    this.serviceCode = details.serviceCode;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** Fields that are safe to log. */
  toLogFields(): Readonly<Record<string, unknown>> {
    return {
      category: this.category,
      operation: this.operation,
      httpStatus: this.httpStatus,
      serviceCode: this.serviceCode,
      retryable: this.retryable,
    };
  }
}

export function isSearchServiceError(error: unknown): error is SearchServiceError {
  return error instanceof SearchServiceError;
}

const MAX_SERVICE_MESSAGE_CHARS = 300;

function replaceControlCharacters(text: string): string {
  let result = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }
  return result;
}

// Quoted values in Azure messages can echo document field values. For schema operations,
// names of fields and properties (short identifiers) are kept because they say what is wrong.
// Every quoted span is matched and then judged, so scanning never restarts at a closing quote.
const QUOTED = /(['"])([^'"]{0,2000})\1/g;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.@/-]{0,63}$/;

/**
 * Makes a service-provided message safe to show and log: control characters removed, quoted
 * values replaced (optionally keeping identifiers), secrets redacted and the length bounded.
 */
export function sanitizeServiceMessage(
  message: string,
  options: { readonly keepQuotedIdentifiers?: boolean } = {},
): string {
  const cleaned = redactString(
    replaceControlCharacters(message).replace(
      QUOTED,
      (whole: string, quote: string, inner: string) =>
        options.keepQuotedIdentifiers === true && IDENTIFIER.test(inner)
          ? whole
          : `${quote}[value]${quote}`,
    ),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_SERVICE_MESSAGE_CHARS
    ? `${cleaned.slice(0, MAX_SERVICE_MESSAGE_CHARS - 1)}…`
    : cleaned;
}
