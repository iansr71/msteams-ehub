import type { Logger } from '@ehub/shared';

import type { EntraUserKey, Invalidation, MappingFailureReason, MappingMethod } from './records.js';
import { userKeyString } from './records.js';

export type CachedAuthorization =
  | {
      readonly kind: 'authorized';
      readonly moodleUserId: number;
      readonly method: MappingMethod;
      readonly courseIds: readonly number[];
    }
  | { readonly kind: 'denied'; readonly reason: MappingFailureReason };

export interface CacheLookup {
  readonly value: CachedAuthorization;
  /** False when the entry is past its TTL and returned only under the stale-grace policy. */
  readonly fresh: boolean;
  readonly ageMs: number;
}

/** Short-lived memory of each user's authorisation, with revocation. */
export interface AuthorizationCache {
  /**
   * The entry for `key` if it is fresh, or, with `staleGraceMs`, if it expired at most that
   * long ago. Never returns an entry fetched before an invalidation that applies to it.
   */
  lookup(
    key: EntraUserKey,
    options?: { readonly staleGraceMs?: number },
  ): Promise<CacheLookup | undefined>;
  set(key: EntraUserKey, value: CachedAuthorization): void;
  invalidate(key: EntraUserKey): void;
  invalidateAll(): void;
  readonly size: number;
}

/** Where invalidations written by other processes (the admin commands) are read from. */
export interface InvalidationSource {
  listInvalidations(): Promise<readonly Invalidation[]>;
}

export interface InMemoryAuthorizationCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  /** Denials are kept for at most this long, so a fixed mapping takes effect soon. */
  readonly deniedTtlMs?: number;
  readonly invalidations?: InvalidationSource;
  /** How long invalidations read from the source are reused. */
  readonly invalidationPollMs?: number;
  readonly logger: Logger;
  readonly now?: () => number;
}

interface Entry {
  readonly value: CachedAuthorization;
  readonly fetchedAt: number;
}

const DEFAULT_DENIED_TTL_MS = 60_000;

/**
 * In-process cache. Entries expire after the TTL; explicit invalidation removes them at once
 * in this process, and invalidations from the shared store (admin commands, enrolment sync)
 * are applied within the poll interval. If the store cannot be read, no cached entry is
 * trusted until it can: Moodle is asked again instead.
 */
export class InMemoryAuthorizationCache implements AuthorizationCache {
  readonly #options: InMemoryAuthorizationCacheOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #logger: Logger;
  #allInvalidatedAt = Number.NEGATIVE_INFINITY;
  #remote:
    | {
        readonly fetchedAt: number;
        readonly all: number;
        readonly users: ReadonlyMap<string, number>;
      }
    | undefined;
  #remoteFailed = false;
  #pending: Promise<void> | undefined;

  constructor(options: InMemoryAuthorizationCacheOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger.child({ component: 'authorization-cache' });
  }

  get size(): number {
    return this.#entries.size;
  }

  async #refreshRemote(): Promise<void> {
    const source = this.#options.invalidations;
    if (source === undefined) {
      return;
    }
    const poll = this.#options.invalidationPollMs ?? 5_000;
    if (
      this.#remote !== undefined &&
      !this.#remoteFailed &&
      this.#now() - this.#remote.fetchedAt < poll
    ) {
      return;
    }
    this.#pending ??= (async () => {
      try {
        const list = await source.listInvalidations();
        let all = Number.NEGATIVE_INFINITY;
        const users = new Map<string, number>();
        for (const entry of list) {
          const at = Date.parse(entry.at);
          if (entry.scope === 'all') {
            all = Math.max(all, at);
          } else {
            const id = userKeyString(entry.scope);
            users.set(id, Math.max(users.get(id) ?? Number.NEGATIVE_INFINITY, at));
          }
        }
        this.#remote = { fetchedAt: this.#now(), all, users };
        this.#remoteFailed = false;
      } catch (error) {
        this.#remoteFailed = true;
        this.#logger.warn(
          'Could not read authorisation invalidations; cached entries are not used.',
          {
            errorType: error instanceof Error ? error.name : typeof error,
          },
        );
      } finally {
        this.#pending = undefined;
      }
    })();
    await this.#pending;
  }

  async lookup(
    key: EntraUserKey,
    options: { readonly staleGraceMs?: number } = {},
  ): Promise<CacheLookup | undefined> {
    const id = userKeyString(key);
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      return undefined;
    }
    await this.#refreshRemote();
    if (this.#remoteFailed) {
      return undefined;
    }
    const invalidatedAt = Math.max(
      this.#allInvalidatedAt,
      this.#remote?.all ?? Number.NEGATIVE_INFINITY,
      this.#remote?.users.get(id) ?? Number.NEGATIVE_INFINITY,
    );
    // Equal timestamps count as invalidated: an entry from the same millisecond is not trusted.
    if (entry.fetchedAt <= invalidatedAt) {
      this.#entries.delete(id);
      return undefined;
    }
    const ageMs = this.#now() - entry.fetchedAt;
    const ttl =
      entry.value.kind === 'denied'
        ? Math.min(this.#options.ttlMs, this.#options.deniedTtlMs ?? DEFAULT_DENIED_TTL_MS)
        : this.#options.ttlMs;
    if (ageMs < ttl) {
      return { value: entry.value, fresh: true, ageMs };
    }
    // A denial is never served stale: it would only delay access, but nothing needs it.
    const grace = entry.value.kind === 'authorized' ? (options.staleGraceMs ?? 0) : 0;
    if (ageMs < ttl + grace) {
      return { value: entry.value, fresh: false, ageMs };
    }
    return undefined;
  }

  set(key: EntraUserKey, value: CachedAuthorization): void {
    const id = userKeyString(key);
    this.#entries.delete(id);
    while (this.#entries.size >= this.#options.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(id, { value, fetchedAt: this.#now() });
  }

  invalidate(key: EntraUserKey): void {
    this.#entries.delete(userKeyString(key));
  }

  invalidateAll(): void {
    this.#entries.clear();
    this.#allInvalidatedAt = this.#now();
  }
}
