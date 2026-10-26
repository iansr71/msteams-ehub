import type { MoodleError } from './errors.js';

export interface RetryPolicy {
  /** Retries after the first attempt (so `maxRetries: 3` means up to 4 attempts). */
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A Retry-After longer than this is not waited for; the error is surfaced instead. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 30_000,
};

export type RandomSource = () => number;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Exponential backoff with "full jitter": a uniformly random delay between 0 and
 * min(maxDelay, base * 2^attempt). Full jitter spreads retries from many workers so they
 * do not hit a recovering Moodle server in synchronized waves.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: RandomSource = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Delay before the next attempt, or `undefined` when the server asked for a longer pause
 * than the policy allows.
 */
export function nextRetryDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: RandomSource = Math.random,
): number | undefined {
  const backoff = computeBackoffDelay(attempt, policy, random);
  if (retryAfterMs === undefined) {
    return backoff;
  }
  if (retryAfterMs > policy.maxRetryAfterMs) {
    return undefined;
  }
  return Math.max(retryAfterMs, backoff);
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-dates always contain a weekday/month name; this rejects inputs like "-1" that
  // Date.parse would otherwise accept as a year.
  const date = /[a-z]/i.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
}

export interface RetryLoopOptions {
  readonly policy: RetryPolicy;
  readonly sleep: Sleep;
  readonly random: RandomSource;
  readonly signal?: AbortSignal;
  /** Converts anything thrown by an attempt into a sanitized Moodle error. */
  readonly normalizeError: (error: unknown) => MoodleError;
  /** Called after every failed attempt, before waiting or rethrowing. */
  readonly onFailure?: (failure: {
    readonly error: MoodleError;
    readonly attempt: number;
    readonly durationMs: number;
    readonly willRetry: boolean;
  }) => void;
  /** Called with the cancellation error when the caller aborts during a backoff wait. */
  readonly cancelledError: () => MoodleError;
}

/**
 * Runs `operation` until it succeeds, a non-retryable error occurs, or retries are exhausted.
 * Only errors marked `retryable` (transient HTTP statuses and network failures) are retried.
 */
export async function runWithRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryLoopOptions,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const started = Date.now();
    try {
      return await operation(attempt);
    } catch (thrown) {
      const error = options.normalizeError(thrown);
      const delay =
        error.retryable && attempt < options.policy.maxRetries
          ? nextRetryDelay(attempt, options.policy, error.retryAfterMs, options.random)
          : undefined;
      options.onFailure?.({
        error,
        attempt,
        durationMs: Date.now() - started,
        willRetry: delay !== undefined,
      });
      if (delay === undefined) {
        throw error;
      }
      try {
        await options.sleep(delay, options.signal);
      } catch {
        throw options.cancelledError();
      }
    }
  }
}

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
