import type { Sleep } from '../http/retry.js';

/** Runs at most `limit` tasks at a time, starting queued tasks in arrival order. */
export class ConcurrencyLimiter {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Concurrency limit must be a positive integer.');
    }
    this.#limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

/**
 * Spaces requests evenly: at most `requestsPerMinute`, one every 60000/n ms. Even spacing keeps
 * well under Azure's per-minute quota without bursts that trigger 429 responses.
 */
export class RequestRateLimiter {
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: Sleep;
  #nextSlot = 0;

  constructor(requestsPerMinute: number, now: () => number, sleep: Sleep) {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new RangeError('requestsPerMinute must be positive.');
    }
    this.#intervalMs = 60_000 / requestsPerMinute;
    this.#now = now;
    this.#sleep = sleep;
  }

  /** Resolves when the caller may send its request. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const now = this.#now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + this.#intervalMs;
    const wait = slot - now;
    if (wait > 0) {
      await this.#sleep(wait, signal);
    }
  }
}
