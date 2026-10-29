const MAX_TEXT_LENGTH = 120;
// C0/C1 controls (terminal escape sequences) and bidirectional overrides (spoofed text).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Replaces control codes and bidirectional overrides with spaces; does not truncate. */
export function replaceUnsafeCharacters(value: string): string {
  return value.replace(UNSAFE_CHARACTERS, ' ');
}

/** Makes untrusted text safe for a terminal: no control codes, one line, bounded. */
export function sanitizeText(value: string | undefined, maxLength = MAX_TEXT_LENGTH): string {
  if (value === undefined) {
    return '-';
  }
  const cleaned = value.replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') {
    return '-';
  }
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}
