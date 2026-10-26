import { describe, expect, it } from 'vitest';

import { MoodleAuthenticationError, MoodleTransportError } from './errors.js';
import {
  computeBackoffDelay,
  defaultSleep,
  nextRetryDelay,
  parseRetryAfter,
  runWithRetries,
  type RetryPolicy,
} from './retry.js';

const policy: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxRetryAfterMs: 5_000,
};

describe('computeBackoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const top = (attempt: number) => computeBackoffDelay(attempt, policy, () => 0.999999);
    expect(top(0)).toBe(99);
    expect(top(1)).toBe(199);
    expect(top(2)).toBe(399);
    expect(top(3)).toBe(799);
    expect(top(10)).toBe(999);
  });

  it('applies full jitter between zero and the ceiling', () => {
    expect(computeBackoffDelay(2, policy, () => 0)).toBe(0);
    expect(computeBackoffDelay(2, policy, () => 0.5)).toBe(200);
    for (let i = 0; i < 200; i += 1) {
      const delay = computeBackoffDelay(3, policy);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(800);
    }
  });
});

describe('nextRetryDelay', () => {
  it('waits at least as long as Retry-After asks', () => {
    expect(nextRetryDelay(0, policy, 2_000, () => 0.5)).toBe(2_000);
  });

  it('gives up when Retry-After exceeds the policy maximum', () => {
    expect(nextRetryDelay(0, policy, 60_000, () => 0.5)).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3_000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Thu, 01 Jan 2025 00:00:05 GMT', now)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-1')).toBeUndefined();
  });
});

describe('runWithRetries', () => {
  const transient = () => new MoodleTransportError('t', { code: 'http_503', retryable: true });
  const base = {
    policy,
    random: () => 0.5,
    normalizeError: (error: unknown) =>
      error instanceof MoodleTransportError || error instanceof MoodleAuthenticationError
        ? error
        : new MoodleTransportError('x', { code: 'unexpected' }),
    cancelledError: () => new MoodleTransportError('cancelled', { code: 'aborted' }),
  };

  it('retries retryable failures up to maxRetries, then throws the last error', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const failure = await runWithRetries(
      () => {
        attempts += 1;
        return Promise.reject(transient());
      },
      { ...base, sleep: (ms) => (delays.push(ms), Promise.resolve()) },
    ).catch((error: unknown) => error);

    expect(attempts).toBe(4);
    expect(delays).toEqual([50, 100, 200]);
    expect(failure).toBeInstanceOf(MoodleTransportError);
  });

  it('succeeds after a transient failure', async () => {
    let attempts = 0;
    const result = await runWithRetries(
      () => {
        attempts += 1;
        return attempts < 3 ? Promise.reject(transient()) : Promise.resolve('ok');
      },
      { ...base, sleep: () => Promise.resolve() },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      runWithRetries(
        () => {
          attempts += 1;
          return Promise.reject(new MoodleAuthenticationError('no', { code: 'invalidtoken' }));
        },
        { ...base, sleep: () => Promise.resolve() },
      ),
    ).rejects.toBeInstanceOf(MoodleAuthenticationError);
    expect(attempts).toBe(1);
  });

  it('reports every failure with the retry decision', async () => {
    const decisions: boolean[] = [];
    await runWithRetries(() => Promise.reject(transient()), {
      ...base,
      policy: { ...policy, maxRetries: 1 },
      sleep: () => Promise.resolve(),
      onFailure: ({ willRetry }) => decisions.push(willRetry),
    }).catch(() => undefined);
    expect(decisions).toEqual([true, false]);
  });

  it('converts a cancelled backoff wait into the cancellation error', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await runWithRetries(() => Promise.reject(transient()), {
      ...base,
      sleep: defaultSleep,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'aborted' });
  });
});

describe('defaultSleep', () => {
  it('resolves after the delay and rejects when aborted', async () => {
    await expect(defaultSleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const pending = defaultSleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });
});
