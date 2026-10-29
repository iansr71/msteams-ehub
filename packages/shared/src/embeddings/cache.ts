import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { EmbeddingMetadata } from './types.js';

/** A stored vector and how it was made. */
export interface CachedEmbedding {
  readonly vector: readonly number[];
  readonly metadata: EmbeddingMetadata;
}

/**
 * Embedding cache keyed by `embeddingCacheKey` (model, version, dimensions, content hash).
 * Implementations treat any unreadable or inconsistent entry as a miss.
 */
export interface EmbeddingCache {
  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedEmbedding>>;
  setMany(entries: readonly CachedEmbedding[]): Promise<void>;
}

const CACHE_KEY = /^[0-9a-f]{64}$/;

/** Bounded in-process cache; the least recently used entry is evicted first. */
export class InMemoryEmbeddingCache implements EmbeddingCache {
  readonly #entries = new Map<string, CachedEmbedding>();
  readonly #maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedEmbedding>> {
    const found = new Map<string, CachedEmbedding>();
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry !== undefined) {
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        found.set(key, entry);
      }
    }
    return Promise.resolve(found);
  }

  setMany(entries: readonly CachedEmbedding[]): Promise<void> {
    for (const entry of entries) {
      this.#entries.delete(entry.metadata.cacheKey);
      this.#entries.set(entry.metadata.cacheKey, entry);
      while (this.#entries.size > this.#maxEntries) {
        const oldest = this.#entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.#entries.delete(oldest);
      }
    }
    return Promise.resolve();
  }
}

const fileEntrySchema = z.strictObject({
  format: z.literal(1),
  vector: z.array(z.number()).min(1).max(8192),
  metadata: z.strictObject({
    modelIdentifier: z.string().min(1),
    embeddingVersion: z.string().min(1),
    dimensions: z.number().int().positive(),
    generatedAt: z.iso.datetime({ offset: true }),
    contentHash: z.string().regex(CACHE_KEY),
    cacheKey: z.string().regex(CACHE_KEY),
  }),
});

const MAX_ENTRY_BYTES = 512 * 1024;

/**
 * One JSON file per entry under `<directory>/<first two hex characters>/<key>.json`, written to
 * a temporary file and renamed so a crash never leaves a partial entry. The files hold vectors
 * (no text), but vectors can leak information about the text: protect the directory like the
 * content itself.
 */
export class FileEmbeddingCache implements EmbeddingCache {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  #path(key: string): string {
    return join(this.#directory, key.slice(0, 2), `${key}.json`);
  }

  async getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedEmbedding>> {
    const found = new Map<string, CachedEmbedding>();
    for (const key of keys) {
      if (!CACHE_KEY.test(key)) {
        continue;
      }
      const entry = await this.#read(key);
      if (entry !== undefined) {
        found.set(key, entry);
      }
    }
    return found;
  }

  async #read(key: string): Promise<CachedEmbedding | undefined> {
    const path = this.#path(key);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_ENTRY_BYTES) {
        return undefined;
      }
      const parsed = fileEntrySchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (
        !parsed.success ||
        parsed.data.metadata.cacheKey !== key ||
        parsed.data.vector.length !== parsed.data.metadata.dimensions
      ) {
        return undefined;
      }
      return { vector: parsed.data.vector, metadata: parsed.data.metadata };
    } catch {
      return undefined;
    }
  }

  async setMany(entries: readonly CachedEmbedding[]): Promise<void> {
    for (const entry of entries) {
      const key = entry.metadata.cacheKey;
      if (!CACHE_KEY.test(key)) {
        continue;
      }
      const path = this.#path(key);
      await mkdir(join(this.#directory, key.slice(0, 2)), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ format: 1, vector: entry.vector, metadata: entry.metadata }),
        { mode: 0o600 },
      );
      await rename(temporary, path);
    }
  }
}
