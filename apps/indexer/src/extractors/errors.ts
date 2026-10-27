import type { ExtractionFailureReason } from './types.js';

/**
 * Thrown by extraction code for expected document problems. The registry converts it into a
 * structured `failed` result. Messages are fixed strings: never document text or file paths.
 */
export class ExtractionFailure extends Error {
  constructor(
    readonly reason: ExtractionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractionFailure';
  }
}

export function isExtractionFailure(error: unknown): error is ExtractionFailure {
  return error instanceof ExtractionFailure;
}
