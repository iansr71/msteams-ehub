import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  MissingCorrelationIdError,
  generateCorrelationId,
  getCorrelationId,
  isValidCorrelationId,
  normalizeCorrelationId,
  requireCorrelationId,
  runWithCorrelationId,
  runWithNewCorrelationId,
} from './correlation.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('correlation IDs', () => {
  it('generates unique UUIDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(UUID_PATTERN);
    }
  });

  it('has no correlation ID outside a context', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(() => requireCorrelationId()).toThrow(MissingCorrelationIdError);
  });

  it('binds a supplied valid ID for the duration of the callback', () => {
    const result = runWithCorrelationId('teams-abc.123:xyz', () => requireCorrelationId());
    expect(result).toBe('teams-abc.123:xyz');
    expect(getCorrelationId()).toBeUndefined();
  });

  it('preserves the ID across awaits, timers and promise chains', async () => {
    const seen = await runWithCorrelationId('async-id', async () => {
      const values: (string | undefined)[] = [getCorrelationId()];
      await delay(1);
      values.push(getCorrelationId());
      await Promise.resolve().then(() => values.push(getCorrelationId()));
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          values.push(getCorrelationId());
          resolve();
        });
      });
      return values;
    });

    expect(seen).toEqual(['async-id', 'async-id', 'async-id', 'async-id']);
  });

  it('isolates concurrent contexts from each other', async () => {
    const run = (id: string, wait: number) =>
      runWithCorrelationId(id, async () => {
        await delay(wait);
        return getCorrelationId();
      });

    const results = await Promise.all([run('first', 15), run('second', 1), run('third', 5)]);

    expect(results).toEqual(['first', 'second', 'third']);
  });

  it('restores the outer ID after a nested context ends', () => {
    runWithCorrelationId('outer', () => {
      const inner = runWithCorrelationId('inner', () => getCorrelationId());
      expect(inner).toBe('inner');
      expect(getCorrelationId()).toBe('outer');
    });
  });

  it.each([
    ['', 'empty'],
    ['has space', 'whitespace'],
    ['line\nbreak', 'newline'],
    ['<script>', 'markup'],
    ['a'.repeat(129), 'too long'],
    ['-leading-dash', 'leading separator'],
    [42, 'non-string'],
    [undefined, 'missing'],
  ])('replaces an unsafe inbound ID (%s: %s) with a generated one', (candidate, label) => {
    expect(isValidCorrelationId(candidate), label).toBe(false);
    const id = runWithCorrelationId(candidate, () => requireCorrelationId());
    expect(id).toMatch(UUID_PATTERN);
    expect(normalizeCorrelationId(candidate)).toMatch(UUID_PATTERN);
  });

  it('accepts a maximum-length safe ID', () => {
    const id = `a${'b'.repeat(127)}`;
    expect(isValidCorrelationId(id)).toBe(true);
    expect(normalizeCorrelationId(id)).toBe(id);
  });

  it('starts a fresh ID for background work', () => {
    const first = runWithNewCorrelationId(() => requireCorrelationId());
    const second = runWithNewCorrelationId(() => requireCorrelationId());
    expect(first).toMatch(UUID_PATTERN);
    expect(second).toMatch(UUID_PATTERN);
    expect(first).not.toBe(second);
  });
});
