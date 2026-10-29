import { createHash } from 'node:crypto';

/*
 * Input preparation and cache keys. The normalised text is what is sent to the model and what
 * is hashed, so the same visible text always maps to the same cache entry.
 */

/** Counts model tokens. Injected; the default is an upper bound (UTF-8 bytes). */
export type CountTokens = (text: string) => number;

const utf8 = new TextEncoder();

/**
 * Every token covers at least one UTF-8 byte, so the byte length never undercounts. Safe for
 * limit checks without a tokenizer; the indexer injects the real tokenizer instead.
 */
export const countTokensUpperBound: CountTokens = (text) => utf8.encode(text).length;

function isRemovedCharacter(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xfeff ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Unicode NFC, control and invisible formatting characters removed, whitespace runs collapsed
 * to one space, trimmed. Returns an empty string when nothing meaningful remains.
 */
export function normalizeEmbeddingInput(text: string): string {
  let cleaned = '';
  for (const character of text.normalize('NFC')) {
    cleaned += isRemovedCharacter(character.codePointAt(0) ?? 0) ? ' ' : character;
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

export function hashEmbeddingInput(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

export interface CacheKeyParts {
  readonly modelIdentifier: string;
  readonly embeddingVersion: string;
  readonly dimensions: number;
  readonly contentHash: string;
}

/**
 * Stable across runs and machines: changing the model, the embedding version or the dimensions
 * gives a new key, so stale vectors are never reused.
 */
export function embeddingCacheKey(parts: CacheKeyParts): string {
  return createHash('sha256')
    .update(
      [
        'ehub-embedding',
        parts.modelIdentifier,
        parts.embeddingVersion,
        String(parts.dimensions),
        parts.contentHash,
      ].join('\u0000'),
    )
    .digest('hex');
}
