import { describe, expect, it } from 'vitest';

import { Deadline, runWithDeadline } from './deadline.js';
import { ExtractionFailure } from './errors.js';
import {
  BlockCollector,
  computeContentHash,
  HeadingTracker,
  normalizeInlineText,
  normalizePreformattedText,
} from './textNormalization.js';
import type { TextBlock } from './types.js';

describe('normalizeInlineText', () => {
  it('applies NFC, removes invisible and bidi characters and collapses whitespace', () => {
    expect(normalizeInlineText('  Café  menu\u200b\n\tnow\u202e!  ')).toBe('Café menu now !');
  });
});

describe('normalizePreformattedText', () => {
  it('keeps lines, trims trailing spaces and limits blank lines', () => {
    expect(normalizePreformattedText('a  \r\n\tb\n\n\n\nc\u0000')).toBe('a\n    b\n\nc');
  });
});

describe('BlockCollector', () => {
  it('normalises, skips empty blocks and records location', () => {
    const collector = new BlockCollector(1000);
    collector.add({ kind: 'paragraph', text: '   ' });
    collector.add({
      kind: 'heading',
      text: ' Title ',
      headingLevel: 2,
      headingPath: [' Root '],
      pageNumber: 3,
    });
    collector.add({ kind: 'paragraph', text: 'Body', headingLevel: 4 });
    expect(collector.blocks).toEqual([
      {
        kind: 'heading',
        text: 'Title',
        headingLevel: 2,
        headingPath: ['Root'],
        pageNumber: 3,
        slideNumber: undefined,
      },
      {
        kind: 'paragraph',
        text: 'Body',
        headingLevel: undefined,
        headingPath: [],
        pageNumber: undefined,
        slideNumber: undefined,
      },
    ]);
    expect(collector.characterCount).toBe(9);
  });

  it('cuts at the limit and refuses further blocks', () => {
    const collector = new BlockCollector(10);
    expect(collector.add({ kind: 'paragraph', text: '12345' })).toBe(true);
    expect(collector.add({ kind: 'paragraph', text: '6789012345' })).toBe(false);
    expect(collector.add({ kind: 'paragraph', text: 'more' })).toBe(false);
    expect(collector.blocks.map((block) => block.text)).toEqual(['12345', '67890']);
    expect(collector.truncated).toBe(true);
  });
});

describe('HeadingTracker', () => {
  it('builds paths from heading levels, popping siblings and deeper levels', () => {
    const tracker = new HeadingTracker(['Book']);
    expect(tracker.enter(1, 'A')).toEqual(['Book']);
    expect(tracker.enter(2, 'A.1')).toEqual(['Book', 'A']);
    expect(tracker.path).toEqual(['Book', 'A', 'A.1']);
    expect(tracker.enter(2, 'A.2')).toEqual(['Book', 'A']);
    expect(tracker.enter(1, 'B')).toEqual(['Book']);
    expect(tracker.enter(3, 'B.x.1')).toEqual(['Book', 'B']);
    expect(tracker.path).toEqual(['Book', 'B', 'B.x.1']);
  });
});

describe('computeContentHash', () => {
  const block = (text: string, pageNumber?: number): TextBlock => ({
    kind: 'paragraph',
    text,
    headingLevel: undefined,
    headingPath: [],
    pageNumber,
    slideNumber: undefined,
  });

  it('is a deterministic SHA-256 hex digest', () => {
    const hash = computeContentHash([block('a'), block('b')]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash([block('a'), block('b')])).toBe(hash);
  });

  it('changes with text, order or location', () => {
    const base = computeContentHash([block('a', 1), block('b', 1)]);
    expect(computeContentHash([block('a', 1), block('c', 1)])).not.toBe(base);
    expect(computeContentHash([block('b', 1), block('a', 1)])).not.toBe(base);
    expect(computeContentHash([block('a', 1), block('b', 2)])).not.toBe(base);
  });

  it('is not fooled by concatenation ambiguity', () => {
    expect(computeContentHash([block('ab'), block('c')])).not.toBe(
      computeContentHash([block('a'), block('bc')]),
    );
  });
});

describe('Deadline and runWithDeadline', () => {
  it('throws a timeout failure once expired', () => {
    let now = 0;
    const deadline = new Deadline(100, () => now);
    expect(() => {
      deadline.check();
    }).not.toThrow();
    now = 100;
    expect(() => {
      deadline.check();
    }).toThrow(ExtractionFailure);
    expect(deadline.remainingMs).toBe(0);
  });

  it('rejects hanging work and aborts the controller', async () => {
    const controller = new AbortController();
    const hanging = new Promise<never>(() => undefined);
    await expect(runWithDeadline(hanging, new Deadline(20), controller)).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(controller.signal.aborted).toBe(true);
  });

  it('returns finished work', async () => {
    await expect(
      runWithDeadline(Promise.resolve(5), new Deadline(1_000), new AbortController()),
    ).resolves.toBe(5);
  });
});
