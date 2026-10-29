import { redactString } from '../logging/redaction.js';

export const EMBEDDING_ERROR_CATEGORIES = [
  'invalid_input',
  'input_too_long',
  'authentication',
  'authorization',
  'not_found',
  'throttled',
  'unavailable',
  'timeout',
  'network',
  'cancelled',
  'invalid_request',
  'invalid_response',
  'dimension_mismatch',
] as const;
export type EmbeddingErrorCategory = (typeof EMBEDDING_ERROR_CATEGORIES)[number];

export interface EmbeddingErrorDetails {
  readonly category: EmbeddingErrorCategory;
  readonly httpStatus?: number;
  /** Azure's machine-readable error code, when present. */
  readonly serviceCode?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  /** Position of the offending input in the caller's list, for input errors. */
  readonly inputIndex?: number;
}

/**
 * Every embedding failure. Messages never contain the input text, vectors, keys or tokens:
 * they are built from the category, HTTP status, Azure error code and input positions.
 */
export class EmbeddingError extends Error {
  readonly category: EmbeddingErrorCategory;
  readonly httpStatus: number | undefined;
  readonly serviceCode: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly inputIndex: number | undefined;

  constructor(message: string, details: EmbeddingErrorDetails) {
    super(redactString(message));
    this.name = 'EmbeddingError';
    this.category = details.category;
    this.httpStatus = details.httpStatus;
    this.serviceCode = details.serviceCode;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
    this.inputIndex = details.inputIndex;
  }

  toLogFields(): Readonly<Record<string, unknown>> {
    return {
      category: this.category,
      httpStatus: this.httpStatus,
      serviceCode: this.serviceCode,
      retryable: this.retryable,
      inputIndex: this.inputIndex,
    };
  }
}

export function isEmbeddingError(error: unknown): error is EmbeddingError {
  return error instanceof EmbeddingError;
}
