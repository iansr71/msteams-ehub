/*
 * Per-user rate limiting and a global concurrency cap for the answer API. Both are in memory,
 * which is correct for the single API replica this deployment runs (docs/infrastructure.md); a
 * second replica would need a shared store.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** How long until another request would be allowed. */
  readonly retryAfterMs?: number;
}

export interface RequestRateLimiter {
  check(key: string): RateLimitDecision;
}

export interface SlidingWindowOptions {
  /** Requests allowed per window, per key. */
  readonly limit: number;
  readonly windowMs: number;
  /** Keys remembered at once; the least recently seen are dropped first. */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

/**
 * A sliding-window log: at most `limit` requests in any `windowMs` for one key. Refused requests
 * are not recorded, so a caller who keeps retrying is not locked out for longer.
 */
export class SlidingWindowRateLimiter implements RequestRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  // Insertion order is recency order: a key is re-inserted each time it is used.
  readonly #hits = new Map<string, number[]>();

  constructor(options: SlidingWindowOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new RangeError('limit must be a positive integer.');
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError('windowMs must be a positive integer.');
    }
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  check(key: string): RateLimitDecision {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);
    this.#hits.delete(key);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.#windowMs - now) };
    }
    recent.push(now);
    this.#hits.set(key, recent);
    while (this.#hits.size > this.#maxKeys) {
      const oldestKey = this.#hits.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.#hits.delete(oldestKey);
    }
    return { allowed: true };
  }

  /** Keys currently tracked (for tests and diagnostics). */
  get size(): number {
    return this.#hits.size;
  }
}

/** Caps how many requests are being worked on at once; excess requests are refused, not queued. */
export class ConcurrencyLimiter {
  readonly #max: number;
  #active = 0;

  constructor(max: number) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError('max must be a positive integer.');
    }
    this.#max = max;
  }

  /** Returns a release function, or undefined when the cap is reached. */
  tryAcquire(): (() => void) | undefined {
    if (this.#active >= this.#max) {
      return undefined;
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#active -= 1;
      }
    };
  }

  get active(): number {
    return this.#active;
  }
}
