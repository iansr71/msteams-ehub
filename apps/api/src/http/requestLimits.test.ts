import { describe, expect, it } from 'vitest';

import { ConcurrencyLimiter, SlidingWindowRateLimiter } from './requestLimits.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('SlidingWindowRateLimiter', () => {
  it('allows the limit, refuses the next, and says when to retry', () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 60_000, now: time.now });
    expect(limiter.check('a')).toEqual({ allowed: true });
    time.advance(10_000);
    expect(limiter.check('a')).toEqual({ allowed: true });
    expect(limiter.check('a')).toEqual({ allowed: true });
    // The oldest request leaves the window 60 s after it was made: 50 s from now.
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterMs: 50_000 });
  });

  it('is a sliding window, not a fixed one', () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1_000, now: time.now });
    limiter.check('a');
    time.advance(900);
    limiter.check('a');
    time.advance(101); // the first request has left the window; the second has not
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('keeps users separate', () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('does not extend the lockout when a refused caller keeps retrying', () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1_000, now: time.now });
    limiter.check('a');
    for (let i = 0; i < 50; i += 1) {
      time.advance(10);
      expect(limiter.check('a').allowed).toBe(false);
    }
    time.advance(501);
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('bounds memory by dropping the least recently seen keys', () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (const key of ['a', 'b', 'c']) limiter.check(key);
    limiter.check('a'); // refused, but marks `a` as recently seen
    limiter.check('d');
    expect(limiter.size).toBe(3);
    expect(limiter.check('a').allowed).toBe(false); // kept
    expect(limiter.check('b').allowed).toBe(true); // dropped, so counted afresh
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects limit %s', (limit) => {
    expect(() => new SlidingWindowRateLimiter({ limit, windowMs: 1_000 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: limit })).toThrow(RangeError);
  });
});

describe('ConcurrencyLimiter', () => {
  it('refuses beyond the cap and frees a slot on release', () => {
    const limiter = new ConcurrencyLimiter(2);
    const first = limiter.tryAcquire();
    const second = limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBeUndefined();
    expect(limiter.active).toBe(2);
    first?.();
    expect(limiter.active).toBe(1);
    expect(limiter.tryAcquire()).toBeTypeOf('function');
    second?.();
  });

  it('ignores a double release', () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.tryAcquire();
    release?.();
    release?.();
    expect(limiter.active).toBe(0);
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBeUndefined();
  });

  it.each([0, -3, 2.5])('rejects max %s', (max) => {
    expect(() => new ConcurrencyLimiter(max)).toThrow(RangeError);
  });
});
