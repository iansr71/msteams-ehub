import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SUPPORTED_MOODLE_FUNCTIONS } from '@ehub/moodle-client';
import { describe, expect, it } from 'vitest';

/*
 * The documented Moodle service functions are what administrators grant the token. If code
 * and documentation drift, the token ends up either over-privileged or missing a function.
 */

const doc = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'docs', 'moodle-setup.md'),
  'utf8',
);

function documentedFunctions(): string[] {
  const start = doc.indexOf('<!-- moodle-functions:start -->');
  const end = doc.indexOf('<!-- moodle-functions:end -->');
  expect(start, 'function table start marker').toBeGreaterThan(-1);
  expect(end, 'function table end marker').toBeGreaterThan(start);
  return [...doc.slice(start, end).matchAll(/^\| `([a-z_]+)`/gm)].map((match) => match[1] ?? '');
}

describe('docs/moodle-setup.md', () => {
  it('lists exactly the web-service functions the client can call, in the same order', () => {
    expect(documentedFunctions()).toEqual([...SUPPORTED_MOODLE_FUNCTIONS]);
  });

  it('only lists read-only core functions', () => {
    for (const name of SUPPORTED_MOODLE_FUNCTIONS) {
      expect(name).toMatch(/^core_[a-z]+_get_[a-z_]+$/);
    }
  });
});
