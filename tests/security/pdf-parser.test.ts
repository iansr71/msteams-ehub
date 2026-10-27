import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The PDF extractor relies on pdfjs-dist never evaluating code derived from a document (the
 * class of CVE-2024-4367). pdfjs 6 removed the eval-based PostScript function compiler, and with
 * it the isEvalSupported option. The only Function-constructor use left is core-js's constant
 * global-object fallback, `Function('return this')`, which takes no input and is unreachable on
 * Node (globalThis exists). This test fails if an upgrade adds any other eval or Function use,
 * so the decision is revisited instead of silently regressing.
 */

const KNOWN_CONSTANT_FALLBACK = "Function('return this')";

const requireFromIndexer = createRequire(
  join(import.meta.dirname, '..', '..', 'apps', 'indexer', 'package.json'),
);
const pdfjsRoot = dirname(requireFromIndexer.resolve('pdfjs-dist/package.json'));

describe('pdfjs-dist', () => {
  it.each(['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'])(
    '%s contains no eval or Function constructor',
    (file) => {
      const source = readFileSync(join(pdfjsRoot, file), 'utf8').replaceAll(
        KNOWN_CONSTANT_FALLBACK,
        '',
      );
      expect(source).not.toMatch(/(?<![\w$.])eval\s*\(/);
      expect(source).not.toMatch(/new\s+Function\s*\(/);
      expect(source).not.toMatch(/(?<![\w$.])Function\s*\(\s*["'`]/);
    },
  );

  it('is pinned to an exact version', () => {
    const indexer = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', 'apps', 'indexer', 'package.json'),
        'utf8',
      ),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(indexer.dependencies['pdfjs-dist']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
