import { describe, expect, it } from 'vitest';

import { createTiktokenCounter } from './tokenCounter.js';

const counter = createTiktokenCounter('cl100k_base');

describe('createTiktokenCounter', () => {
  it('counts real cl100k_base tokens', () => {
    expect(counter.encoding).toBe('cl100k_base');
    expect(counter.count('')).toBe(0);
    expect(counter.count('Hello world')).toBe(2);
  });

  it('treats special-token strings in documents as ordinary text instead of throwing', () => {
    expect(() => counter.count('before <|endoftext|> after')).not.toThrow();
    expect(counter.count('before <|endoftext|> after')).toBeGreaterThan(3);
  });

  it('supports the o200k_base encoding', () => {
    expect(createTiktokenCounter('o200k_base').count('Hello world')).toBe(2);
  });

  it('splits by tokens without losing or reordering text', () => {
    const text = 'The client should avoid direct sun for 48 hours after a peel. '.repeat(20);
    const pieces = counter.splitByTokens(text, 25);
    expect(pieces.join('')).toBe(text);
    expect(pieces.every((piece) => counter.count(piece) <= 25)).toBe(true);
  });

  it('does not cut a multi-byte character in half', () => {
    const text = '😀'.repeat(40);
    const pieces = counter.splitByTokens(text, 5);
    expect(pieces.join('')).toBe(text);
    expect(pieces.some((piece) => piece.includes('�'))).toBe(false);
  });

  it('counts a huge unbroken run quickly (no quadratic blow-up)', () => {
    const started = Date.now();
    const tokens = counter.count('A'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(tokens).toBeGreaterThan(10_000);
  });

  it('counts ordinary text exactly, and long unbroken runs as an upper bound', () => {
    const prose = 'Record allergies in the client profile before any treatment.';
    expect(counter.count(prose)).toBe(10);
    const blob = 'QUJD'.repeat(50);
    expect(counter.count(blob)).toBe(200);
    // Splitting around the run can cost about one token at each junction.
    const combined = counter.count(`${prose} ${blob}`);
    expect(combined).toBeGreaterThanOrEqual(counter.count(prose) + 200);
    expect(combined).toBeLessThanOrEqual(counter.count(prose) + 202);
  });

  it('splits long runs into pieces that fit by the same measure', () => {
    const pieces = counter.splitByTokens('Z'.repeat(1000), 300);
    expect(pieces.join('')).toBe('Z'.repeat(1000));
    expect(pieces.every((piece) => counter.count(piece) <= 300)).toBe(true);
  });

  it('rejects a non-positive split size', () => {
    expect(() => counter.splitByTokens('text', 0)).toThrow(RangeError);
  });
});
