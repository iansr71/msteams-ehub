import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

/** Counts and splits text in model tokens. Injected so tests can use a simple counter. */
export interface TokenCounter {
  /** Identifies the tokenizer; recorded so chunk sizes can be interpreted later. */
  readonly encoding: string;
  count(text: string): number;
  /**
   * Splits text into consecutive pieces of at most `maxTokens` tokens each (as measured by
   * `count`). Last-resort splitting for text with no better boundary, e.g. a huge URL.
   */
  splitByTokens(text: string, maxTokens: number): string[];
}

export type TiktokenEncoding = 'cl100k_base' | 'o200k_base';

const RANKS = { cl100k_base: cl100kBase, o200k_base: o200kBase } as const;
const encoders = new Map<TiktokenEncoding, Tiktoken>();

function encoderFor(encoding: TiktokenEncoding): Tiktoken {
  let encoder = encoders.get(encoding);
  if (encoder === undefined) {
    encoder = new Tiktoken(RANKS[encoding]);
    encoders.set(encoding, encoder);
  }
  return encoder;
}

// Documents are untrusted and may contain strings such as "<|endoftext|>". By default tiktoken
// throws on them; here they are encoded as ordinary text, never as special tokens.
const NO_SPECIAL_TOKENS: string[] = [];
const REPLACEMENT = String.fromCharCode(0xfffd);

/*
 * The JavaScript BPE is quadratic in the length of an unbroken run of repetitive characters
 * (a 4,000-character run of one letter takes ~1.7 s), and untrusted documents can contain such
 * runs. Runs longer than LONG_RUN_CHARS are therefore not encoded: they are counted as their
 * UTF-8 byte length, which is an upper bound (every token covers at least one byte). Ordinary
 * text, including typical URLs, is counted exactly.
 */
const LONG_RUN_CHARS = 64;
const LONG_RUN_SOURCE = `\\S{${String(LONG_RUN_CHARS + 1)},}`;
// Separate non-global regex for testing: a shared global regex carries lastIndex between calls,
// and matchAll copies it, which silently skipped every match.
const HAS_LONG_RUN = new RegExp(LONG_RUN_SOURCE);
const utf8 = new TextEncoder();

function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

function hasLongRun(text: string): boolean {
  return HAS_LONG_RUN.test(text);
}

/** Splits on code points so no piece exceeds `maxBytes` UTF-8 bytes. */
function splitByBytes(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of text) {
    const size = utf8Length(character);
    if (bytes + size > maxBytes && current !== '') {
      pieces.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current !== '') {
    pieces.push(current);
  }
  return pieces;
}

export function createTiktokenCounter(encoding: TiktokenEncoding): TokenCounter {
  const encoder = encoderFor(encoding);
  const encode = (text: string): number[] =>
    encoder.encode(text, NO_SPECIAL_TOKENS, NO_SPECIAL_TOKENS);

  const count = (text: string): number => {
    if (text === '') {
      return 0;
    }
    if (!hasLongRun(text)) {
      return encode(text).length;
    }
    let total = 0;
    let last = 0;
    for (const match of text.matchAll(new RegExp(LONG_RUN_SOURCE, 'g'))) {
      total += encode(text.slice(last, match.index)).length + utf8Length(match[0]);
      last = match.index + match[0].length;
    }
    return total + encode(text.slice(last)).length;
  };

  return {
    encoding,
    count,
    splitByTokens: (text, maxTokens) => {
      if (maxTokens < 1) {
        throw new RangeError('maxTokens must be at least 1.');
      }
      if (hasLongRun(text)) {
        // Byte length bounds the token count from above, so byte-sized pieces always fit.
        return splitByBytes(text, maxTokens);
      }
      const tokens = encode(text);
      const pieces: string[] = [];
      let start = 0;
      while (start < tokens.length) {
        let end = Math.min(start + maxTokens, tokens.length);
        let piece = encoder.decode(tokens.slice(start, end));
        // A multi-byte character can span tokens; move the cut back so it is not split in half.
        for (
          let back = 0;
          end < tokens.length && back < 3 && end - 1 > start && piece.endsWith(REPLACEMENT);
          back += 1
        ) {
          end -= 1;
          piece = encoder.decode(tokens.slice(start, end));
        }
        pieces.push(piece);
        start = end;
      }
      return pieces;
    },
  };
}
