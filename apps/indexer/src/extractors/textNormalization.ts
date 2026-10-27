import { createHash } from 'node:crypto';

import type { TextBlock, TextBlockKind } from './types.js';

// C0/C1 controls except tab and newline, zero-width characters, and bidi overrides.
const UNWANTED =
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Inline text: NFC, invisible/control characters removed, all whitespace collapsed. */
export function normalizeInlineText(text: string): string {
  return text.normalize('NFC').replace(UNWANTED, ' ').replace(/\s+/g, ' ').trim();
}

/** Preformatted text: keeps line structure, trims trailing spaces, limits blank lines. */
export function normalizePreformattedText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(UNWANTED, ' ')
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface BlockInput {
  readonly kind: TextBlockKind;
  readonly text: string;
  readonly headingLevel?: number;
  readonly headingPath?: readonly string[];
  readonly pageNumber?: number;
  readonly slideNumber?: number;
}

/**
 * Normalises and accumulates blocks under the extracted-text limit. Once the limit is hit the
 * last block is cut at the limit and further blocks are refused (`truncated` becomes true).
 */
export class BlockCollector {
  readonly #blocks: TextBlock[] = [];
  readonly #maxChars: number;
  #chars = 0;
  #truncated = false;

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  get blocks(): readonly TextBlock[] {
    return this.#blocks;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get characterCount(): number {
    return this.#chars;
  }

  /** Returns false once the text limit has been reached. Empty blocks are ignored. */
  add(input: BlockInput): boolean {
    if (this.#truncated) {
      return false;
    }
    let text =
      input.kind === 'preformatted'
        ? normalizePreformattedText(input.text)
        : normalizeInlineText(input.text);
    if (text === '') {
      return true;
    }
    const remaining = this.#maxChars - this.#chars;
    if (text.length > remaining) {
      text = text.slice(0, remaining).trimEnd();
      this.#truncated = true;
      if (text === '') {
        return false;
      }
    }
    this.#chars += text.length;
    this.#blocks.push({
      kind: input.kind,
      text,
      headingLevel: input.kind === 'heading' ? input.headingLevel : undefined,
      headingPath: (input.headingPath ?? [])
        .map(normalizeInlineText)
        .filter((title) => title !== ''),
      pageNumber: input.pageNumber,
      slideNumber: input.slideNumber,
    });
    return !this.#truncated;
  }
}

/** Tracks the enclosing headings while walking a document. */
export class HeadingTracker {
  readonly #base: readonly string[];
  readonly #stack: { level: number; title: string }[] = [];

  constructor(base: readonly string[] = []) {
    this.#base = base;
  }

  /** Path for a block at the current position. */
  get path(): string[] {
    return [...this.#base, ...this.#stack.map((entry) => entry.title)];
  }

  /** Registers a heading and returns the path of its ancestors. */
  enter(level: number, title: string): string[] {
    while (this.#stack.length > 0 && (this.#stack.at(-1)?.level ?? 0) >= level) {
      this.#stack.pop();
    }
    const ancestors = this.path;
    const normalized = normalizeInlineText(title);
    if (normalized !== '') {
      this.#stack.push({ level, title: normalized });
    }
    return ancestors;
  }
}

const HASH_FORMAT_VERSION = 'ehub-content-v1';

/**
 * SHA-256 over the normalised blocks, one JSON line per block (kind, heading level, page, slide,
 * heading path, text). Location is included so moving text between pages or slides changes the
 * hash; the extractor version is not, so a parser upgrade that yields identical text does not
 * force re-indexing.
 */
export function computeContentHash(blocks: readonly TextBlock[]): string {
  const hash = createHash('sha256');
  hash.update(`${HASH_FORMAT_VERSION}\n`);
  for (const block of blocks) {
    hash.update(
      `${JSON.stringify([
        block.kind,
        block.headingLevel ?? null,
        block.pageNumber ?? null,
        block.slideNumber ?? null,
        block.headingPath,
        block.text,
      ])}\n`,
    );
  }
  return hash.digest('hex');
}
