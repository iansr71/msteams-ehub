import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { z } from 'zod';

/*
 * Append-only event files, one JSON line per event and one file per UTC day (`YYYY-MM-DD.jsonl`).
 * Appends of a single small line are atomic on local file systems, so the API and the admin
 * commands can write concurrently without a lock. Retention deletes whole days. Lines that do
 * not validate are skipped and counted, never trusted.
 */

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

export interface EventStore<T> {
  append(event: T): Promise<void>;
  /** Events from `since` onwards, oldest first, plus how many stored lines were invalid. */
  read(since: Date): Promise<{ readonly events: readonly T[]; readonly invalid: number }>;
  /** Deletes days older than `retentionDays`; returns the number of day files removed. */
  prune(retentionDays: number): Promise<number>;
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class FileEventStore<T> implements EventStore<T> {
  readonly #directory: string;
  readonly #schema: z.ZodType<T>;
  readonly #timeOf: (event: T) => string;
  readonly #now: () => Date;

  constructor(options: {
    readonly directory: string;
    readonly schema: z.ZodType<T>;
    /** The event's ISO timestamp; it decides the day file. */
    readonly timeOf: (event: T) => string;
    readonly now?: () => Date;
  }) {
    this.#directory = options.directory;
    this.#schema = options.schema;
    this.#timeOf = options.timeOf;
    this.#now = options.now ?? (() => new Date());
  }

  async append(event: T): Promise<void> {
    const valid = this.#schema.parse(event);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const day = dayOf(new Date(this.#timeOf(valid)));
    await appendFile(join(this.#directory, `${day}.jsonl`), `${JSON.stringify(valid)}\n`, {
      mode: 0o600,
    });
  }

  async #days(): Promise<string[]> {
    try {
      return (await readdir(this.#directory))
        .map((name) => DAY_FILE.exec(name)?.[1])
        .filter((day): day is string => day !== undefined)
        .sort();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async read(since: Date): Promise<{ readonly events: readonly T[]; readonly invalid: number }> {
    const first = dayOf(since);
    const events: T[] = [];
    let invalid = 0;
    for (const day of await this.#days()) {
      if (day < first) {
        continue;
      }
      const text = await readFile(join(this.#directory, `${day}.jsonl`), 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') {
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          invalid += 1;
          continue;
        }
        const parsed = this.#schema.safeParse(raw);
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        if (Date.parse(this.#timeOf(parsed.data)) >= since.getTime()) {
          events.push(parsed.data);
        }
      }
    }
    events.sort((a, b) => Date.parse(this.#timeOf(a)) - Date.parse(this.#timeOf(b)));
    return { events, invalid };
  }

  async prune(retentionDays: number): Promise<number> {
    const cutoff = dayOf(new Date(this.#now().getTime() - retentionDays * DAY_MS));
    let removed = 0;
    for (const day of await this.#days()) {
      if (day < cutoff) {
        await rm(join(this.#directory, `${day}.jsonl`), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

/** For tests. */
export class InMemoryEventStore<T> implements EventStore<T> {
  readonly events: T[] = [];
  readonly #schema: z.ZodType<T>;
  readonly #timeOf: (event: T) => string;
  readonly #now: () => Date;

  constructor(options: {
    readonly schema: z.ZodType<T>;
    readonly timeOf: (event: T) => string;
    readonly now?: () => Date;
  }) {
    this.#schema = options.schema;
    this.#timeOf = options.timeOf;
    this.#now = options.now ?? (() => new Date());
  }

  append(event: T): Promise<void> {
    this.events.push(this.#schema.parse(event));
    return Promise.resolve();
  }

  read(since: Date): Promise<{ readonly events: readonly T[]; readonly invalid: number }> {
    return Promise.resolve({
      events: this.events.filter((event) => Date.parse(this.#timeOf(event)) >= since.getTime()),
      invalid: 0,
    });
  }

  prune(retentionDays: number): Promise<number> {
    const cutoff = this.#now().getTime() - retentionDays * DAY_MS;
    const before = this.events.length;
    const kept = this.events.filter((event) => Date.parse(this.#timeOf(event)) >= cutoff);
    this.events.splice(0, this.events.length, ...kept);
    return Promise.resolve(before - kept.length);
  }
}
