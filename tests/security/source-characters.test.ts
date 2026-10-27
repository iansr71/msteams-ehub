import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * Source files must not contain invisible, control or bidirectional-override characters
 * ("Trojan Source", CVE-2021-42574): they can make code read differently from how it runs.
 * Write them as escapes (\u202e) instead.
 */

const repoRoot = resolve(import.meta.dirname, '..', '..');
const SCANNED_DIRECTORIES = ['apps', 'packages', 'tests', 'scripts', 'docs'];
const SCANNED_EXTENSIONS = /\.(?:ts|mts|cts|js|mjs|cjs|json|md|py|ya?ml)$/;
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '__fixtures__']);
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/u;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(path);
    } else if (SCANNED_EXTENSIONS.test(entry.name)) {
      yield path;
    }
  }
}

describe('source characters', () => {
  it('contains no invisible, control or bidi-override characters', () => {
    const offenders: string[] = [];
    for (const directory of SCANNED_DIRECTORIES) {
      for (const file of sourceFiles(join(repoRoot, directory))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (FORBIDDEN.test(line)) {
            offenders.push(`${relative(repoRoot, file)}:${String(index + 1)}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
