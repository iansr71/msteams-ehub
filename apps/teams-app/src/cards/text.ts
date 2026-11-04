import type { RichTextBlock, TextRun } from './adaptiveCard.js';

// C0/C1 controls except tab and newline, plus bidirectional overrides and isolates, which can
// make displayed text read differently from what it is.
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Makes untrusted text safe for a TextRun: NFC, unsafe characters removed, whitespace tidied,
 * Adaptive Card date/time templates (`{{DATE(...)}}`) defused, and cut to `maxChars` code
 * points. TextRun does not interpret Markdown, so no escaping is needed beyond this.
 */
export function cleanCardText(
  value: string,
  maxChars: number,
  options: { readonly trim?: boolean } = {},
): string {
  const tidied = value
    .normalize('NFC')
    .replace(UNSAFE_CHARACTERS, '')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replaceAll('{{', '{\u200B{');
  const cleaned = options.trim === false ? tidied : tidied.trim();
  const points = Array.from(cleaned);
  if (points.length <= maxChars) {
    return cleaned;
  }
  return `${points
    .slice(0, Math.max(0, maxChars - 1))
    .join('')
    .trimEnd()}…`;
}

/** A plain-text run. Edge spaces are kept, because runs are joined without separators. */
export function run(
  text: string,
  maxChars: number,
  style: Omit<TextRun, 'type' | 'text'> = {},
): TextRun {
  return { type: 'TextRun', text: cleanCardText(text, maxChars, { trim: false }), ...style };
}

export function richText(
  inlines: readonly TextRun[],
  spacing?: RichTextBlock['spacing'],
): RichTextBlock {
  return {
    type: 'RichTextBlock',
    inlines: inlines.filter((inline) => inline.text !== ''),
    ...(spacing === undefined ? {} : { spacing }),
  };
}

const MAX_URL_CHARS = 2_048;

/**
 * Returns a link only if it is https, has no user name or password, and (when hosts are
 * given) is on an allowed host. The API already approves links; this is a second check at the
 * point where a link becomes clickable.
 */
export function safeLink(
  url: string | undefined,
  allowedHosts: ReadonlySet<string> | undefined,
): string | undefined {
  if (url === undefined || url.length > MAX_URL_CHARS) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return undefined;
  }
  if (allowedHosts !== undefined && !allowedHosts.has(parsed.hostname.toLowerCase())) {
    return undefined;
  }
  return parsed.href;
}
