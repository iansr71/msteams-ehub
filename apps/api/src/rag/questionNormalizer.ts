import { replaceUnsafeCharacters } from '@ehub/shared';

export class QuestionValidationError extends Error {
  readonly code: 'empty' | 'too_long';

  constructor(code: 'empty' | 'too_long', message: string) {
    super(message);
    this.name = 'QuestionValidationError';
    this.code = code;
  }
}

/**
 * Cleans a question without changing its meaning: Unicode NFC, control and bidirectional
 * override characters replaced, whitespace collapsed, trimmed. Case, wording and punctuation
 * are kept. Over-long questions are rejected rather than cut, which could change the meaning.
 */
export class QuestionNormalizer {
  readonly #maxChars: number;

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  normalize(question: string): string {
    const normalized = replaceUnsafeCharacters(question.normalize('NFC'))
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized === '') {
      throw new QuestionValidationError('empty', 'The question is empty.');
    }
    if (normalized.length > this.#maxChars) {
      throw new QuestionValidationError(
        'too_long',
        `The question is longer than ${String(this.#maxChars)} characters.`,
      );
    }
    return normalized;
  }
}
