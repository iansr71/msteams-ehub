import { describe, expect, it } from 'vitest';

import {
  block,
  document,
  heading,
  sentences,
  TEST_CONTEXT,
  wordCounter,
  words,
} from './__fixtures__/documents.js';
import { ChunkingError, StructuredChunker, type ChunkingOptions } from './chunkContent.js';
import { CHUNKER_VERSION, type ContentChunk } from './chunkMetadata.js';
import { normalizeContent, type ExtractedDocument } from './normalizeContent.js';
import { createTiktokenCounter } from './tokenCounter.js';

const SMALL: ChunkingOptions = { targetTokens: 50, maxTokens: 60, minTokens: 10, overlapTokens: 8 };

function chunk(doc: ExtractedDocument, options: ChunkingOptions = SMALL): ContentChunk[] {
  return new StructuredChunker(options, wordCounter).chunk(normalizeContent(doc), TEST_CONTEXT);
}

const bodyOf = (item: ContentChunk): string =>
  item.overlapTokens === 0 ? item.content : item.content.split('\n\n').slice(1).join('\n\n');

describe('StructuredChunker: small documents', () => {
  it('keeps a small document in one chunk with its heading context', () => {
    const chunks = chunk(
      document([
        heading('Aftercare guide', 1),
        block({ text: 'Follow these steps after every peel.', path: ['Aftercare guide'] }),
      ]),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunkNumber: 1,
      chunkCount: 1,
      content: '# Aftercare guide\n\nFollow these steps after every peel.',
      headingPath: ['Aftercare guide'],
      title: 'Aftercare guide',
      overlapTokens: 0,
      tokenCount: 9,
    });
  });

  it('returns no chunks for a document with no blocks', () => {
    expect(chunk(document([]))).toEqual([]);
  });
});

describe('StructuredChunker: headings', () => {
  it('splits at nested headings and gives every chunk its heading path', () => {
    const chunks = chunk(
      document([
        heading('Treatments', 1),
        block({ text: words(30, 'intro'), path: ['Treatments'] }),
        heading('Peels', 2, ['Treatments']),
        block({ text: words(30, 'peel'), path: ['Treatments', 'Peels'] }),
        heading('Aftercare', 3, ['Treatments', 'Peels']),
        block({ text: words(30, 'after'), path: ['Treatments', 'Peels', 'Aftercare'] }),
        heading('Lasers', 2, ['Treatments']),
        block({ text: words(30, 'laser'), path: ['Treatments', 'Lasers'] }),
      ]),
    );
    expect(chunks.map((item) => [item.headingPath, item.content.split('\n\n')[0]])).toEqual([
      [['Treatments'], '# Treatments'],
      [['Treatments', 'Peels'], '## Peels'],
      [['Treatments', 'Peels', 'Aftercare'], '### Aftercare'],
      [['Treatments', 'Lasers'], '## Lasers'],
    ]);
    expect(chunks.every((item) => item.overlapTokens === 0)).toBe(true);
  });

  it('merges a tiny subsection into its neighbour instead of emitting a tiny chunk', () => {
    const chunks = chunk(
      document([
        heading('Guide', 1),
        heading('Short', 2, ['Guide']),
        block({ text: 'Tiny note.', path: ['Guide', 'Short'] }),
        heading('Long', 2, ['Guide']),
        block({ text: words(30), path: ['Guide', 'Long'] }),
      ]),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('## Short\n\nTiny note.\n\n## Long');
  });

  it('never merges two document sections, but never leaves a heading alone', () => {
    const chunks = chunk(
      document([
        heading('Part A', 1),
        heading('Intro', 2, ['Part A']),
        block({ text: words(20, 'a'), path: ['Part A', 'Intro'] }),
        heading('Part B', 1),
        block({ text: 'Tiny.', path: ['Part B'] }),
      ]),
    );
    expect(chunks.map((item) => item.headingPath)).toEqual([['Part A'], ['Part B']]);
    expect(chunks[0]?.content.startsWith('# Part A\n\n## Intro')).toBe(true);
  });
});

describe('StructuredChunker: lists and paragraphs', () => {
  it('keeps list items together and joins them with single newlines', () => {
    const items = Array.from({ length: 5 }, (_v, i) =>
      block({ kind: 'list-item', text: `Step ${String(i + 1)}`, path: ['Steps'] }),
    );
    const chunks = chunk(document([heading('Steps', 1), ...items]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('# Steps\n\n- Step 1\n- Step 2\n- Step 3\n- Step 4\n- Step 5');
  });

  it('splits a long list between items, not inside them, with overlap', () => {
    const items = Array.from({ length: 12 }, (_v, i) =>
      block({ kind: 'list-item', text: words(9, `item${String(i)}x`), path: ['List'] }),
    );
    const chunks = chunk(document([heading('List', 1), ...items]));
    expect(chunks.length).toBeGreaterThan(1);
    for (const item of chunks) {
      expect(item.tokenCount).toBeLessThanOrEqual(60);
      for (const line of bodyOf(item)
        .split('\n')
        .filter((l) => l.startsWith('- '))) {
        expect(line.split(' ')).toHaveLength(10);
      }
    }
    expect(chunks[1]?.overlapTokens).toBeGreaterThan(0);
  });

  it('packs paragraphs up to the target and prefers paragraph boundaries', () => {
    const paragraphs = Array.from({ length: 6 }, (_v, i) =>
      block({ text: words(20, `p${String(i)}x`), path: ['S'] }),
    );
    const chunks = chunk(document([heading('S', 1), ...paragraphs]));
    for (const item of chunks) {
      const body = bodyOf(item).split('\n\n');
      for (const paragraph of body.filter((part) => !part.startsWith('#'))) {
        expect(paragraph.split(' ')).toHaveLength(20);
      }
      expect(item.tokenCount).toBeLessThanOrEqual(60);
    }
  });
});

describe('StructuredChunker: oversized content', () => {
  it('splits one oversized paragraph at sentence boundaries', () => {
    const chunks = chunk(document([block({ text: sentences(20, 10) })]));
    expect(chunks.length).toBeGreaterThan(3);
    for (const item of chunks) {
      expect(item.tokenCount).toBeLessThanOrEqual(60);
      expect(bodyOf(item).trimEnd().endsWith('.')).toBe(true);
    }
    const allText = chunks.map(bodyOf).join(' ');
    for (let index = 0; index < 20; index += 1) {
      expect(allText).toContain(`end${String(index)}.`);
    }
  });

  it('splits an oversized sentence between words, and a boundary-less blob by tokens', () => {
    const longSentence = `${words(150, 'long')}.`;
    const blob = 'x'.repeat(200);
    // Additive like the real counter: a space-free run of 30+ characters counts one per character.
    const counter = {
      ...wordCounter,
      count: (text: string) =>
        text
          .split(/\s+/)
          .filter(Boolean)
          .reduce((sum, word) => sum + (word.length > 30 ? word.length : 1), 0),
      splitByTokens: (text: string, maxTokens: number) =>
        Array.from({ length: Math.ceil(text.length / maxTokens) }, (_v, i) =>
          text.slice(i * maxTokens, (i + 1) * maxTokens),
        ),
    };
    const chunks = new StructuredChunker(SMALL, counter).chunk(
      normalizeContent(document([block({ text: longSentence }), block({ text: blob })])),
      TEST_CONTEXT,
    );
    expect(chunks.every((item) => item.tokenCount <= 60)).toBe(true);
    const all = chunks.map(bodyOf).join('');
    expect(all).toContain('long149.');
    expect(all.replace(/[^x]/g, '')).toHaveLength(200);
  });

  it('never leaves a heading alone in front of an oversized paragraph', () => {
    const chunks = chunk(
      document([heading('Guide', 1), block({ text: sentences(15, 10), path: ['Guide'] })]),
    );
    expect(chunks[0]?.content.startsWith('# Guide\n\n')).toBe(true);
    expect(chunks.every((item) => item.content.replace(/^#+ \S+\s*/, '') !== '')).toBe(true);
  });

  it('never produces a chunk above the maximum, with the real tokenizer and defaults', () => {
    const big = Array.from({ length: 40 }, (_v, i) =>
      block({
        text: `${sentences(30, 18, `para${String(i)}`)} https://example.test/${'a'.repeat(3000)}`,
      }),
    );
    const chunker = new StructuredChunker(
      { targetTokens: 850, maxTokens: 1000, minTokens: 100, overlapTokens: 125 },
      createTiktokenCounter('cl100k_base'),
    );
    const chunks = chunker.chunk(normalizeContent(document(big)), TEST_CONTEXT);
    expect(chunks.length).toBeGreaterThan(10);
    for (const item of chunks) {
      expect(item.tokenCount).toBeLessThanOrEqual(1000);
      expect(item.overlapTokens).toBeLessThanOrEqual(125);
    }
  });
});

describe('StructuredChunker: pages and slides', () => {
  it('keeps PDF pages apart when each page is substantial', () => {
    const pages = [1, 2, 3].map((page) => block({ text: words(30, `page${String(page)}x`), page }));
    const chunks = chunk(document(pages, 'pdf'));
    expect(chunks.map((item) => [item.pageNumber, item.pageNumberEnd])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, undefined],
    ]);
    expect(chunks.every((item) => item.overlapTokens === 0)).toBe(true);
  });

  it('merges tiny PDF pages and records the page range', () => {
    const chunks = chunk(
      document(
        [
          block({ text: words(30), page: 1 }),
          block({ text: 'Short page.', page: 2 }),
          block({ text: words(30, 'z'), page: 3 }),
        ],
        'pdf',
      ),
    );
    expect(chunks.map((item) => [item.pageNumber, item.pageNumberEnd])).toEqual([
      [1, 2],
      [3, undefined],
    ]);
  });

  it('chunks a large PDF without mixing substantial pages', () => {
    const blocks = Array.from({ length: 30 }, (_v, page) => [
      heading(`Page ${String(page + 1)} topic`, 1, [], { page: page + 1 }),
      block({
        text: sentences(8, 10, `pg${String(page)}`),
        path: [`Page ${String(page + 1)} topic`],
        page: page + 1,
      }),
    ]).flat();
    const chunks = chunk(document(blocks, 'pdf'));
    expect(chunks.length).toBeGreaterThanOrEqual(30);
    for (const item of chunks) {
      expect(item.pageNumberEnd).toBeUndefined();
      expect(item.tokenCount).toBeLessThanOrEqual(60);
    }
    expect(new Set(chunks.map((item) => item.pageNumber)).size).toBe(30);
  });

  it('never mixes PowerPoint slides, even tiny ones', () => {
    const blocks = [1, 2, 3].flatMap((slide) => [
      heading(`Slide ${String(slide)}`, 1, [], { slide }),
      block({ text: 'Short bullet.', path: [`Slide ${String(slide)}`], slide }),
    ]);
    const chunks = chunk(document(blocks, 'pptx'));
    expect(chunks.map((item) => [item.slideNumber, item.title])).toEqual([
      [1, 'Slide 1'],
      [2, 'Slide 2'],
      [3, 'Slide 3'],
    ]);
  });
});

describe('StructuredChunker: overlap', () => {
  it('carries trailing whole sentences into the next chunk of the same section only', () => {
    const chunks = chunk(
      document([
        heading('S', 1),
        block({ text: sentences(12, 10), path: ['S'] }),
        heading('T', 1),
        block({ text: words(20), path: ['T'] }),
      ]),
    );
    const sameSection = chunks.filter((item) => item.headingPath[0] === 'S');
    expect(sameSection.length).toBeGreaterThan(1);
    const [first, second] = sameSection;
    expect(second?.overlapTokens).toBeGreaterThan(0);
    expect(second?.overlapTokens).toBeLessThanOrEqual(8);
    const overlap = second?.content.split('\n\n')[0] ?? '';
    expect(first?.content.endsWith(overlap)).toBe(true);
    expect(chunks.find((item) => item.headingPath[0] === 'T')?.overlapTokens).toBe(0);
  });

  it('can be disabled', () => {
    const chunks = chunk(document([block({ text: sentences(12, 10) })]), {
      ...SMALL,
      overlapTokens: 0,
    });
    expect(chunks.every((item) => item.overlapTokens === 0)).toBe(true);
  });
});

describe('StructuredChunker: determinism and metadata', () => {
  const doc = document([heading('Guide', 1), block({ text: sentences(15, 10), path: ['Guide'] })]);

  it('produces identical chunks and IDs for identical input', () => {
    const first = chunk(doc);
    const second = chunk(doc);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(new Set(first.map((item) => item.chunkId)).size).toBe(first.length);
  });

  it('keeps chunk IDs stable by position when content changes, and distinct per tenant and resource', () => {
    const original = chunk(doc);
    const edited = chunk(
      document([heading('Guide', 1), block({ text: sentences(15, 11), path: ['Guide'] })]),
    );
    expect(edited[0]?.chunkId).toBe(original[0]?.chunkId);
    expect(edited[0]?.contentHash).not.toBe(original[0]?.contentHash);

    const otherResource = chunk(
      document(doc.blocks, 'docx', { resourceId: '502:file:/other.docx' }),
    );
    expect(otherResource[0]?.chunkId).not.toBe(original[0]?.chunkId);
    const otherTenant = new StructuredChunker(SMALL, wordCounter).chunk(normalizeContent(doc), {
      ...TEST_CONTEXT,
      tenantId: 'other-tenant',
    });
    expect(otherTenant[0]?.chunkId).not.toBe(original[0]?.chunkId);
  });

  it('preserves source metadata, versions and access lists on every chunk', () => {
    for (const item of chunk(doc)) {
      expect(item).toMatchObject({
        tenantId: TEST_CONTEXT.tenantId,
        courseId: 12,
        courseName: 'Consultation Standards',
        courseCategory: '3',
        sectionId: 101,
        sectionName: 'General',
        moduleId: 501,
        moduleName: 'Aftercare guide',
        resourceId: '501:file:/aftercare.docx',
        resourceName: 'aftercare.docx',
        resourceType: 'docx',
        fileName: 'aftercare.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sourceUrl:
          'https://ehub.example.test/webservice/pluginfile.php/5501/mod_resource/content/3/aftercare.docx',
        moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=501',
        sourceContentHash: 'a'.repeat(64),
        modifiedAt: '2025-06-15T15:15:00.000Z',
        indexedAt: '2026-10-28T10:00:00.000Z',
        extractorVersion: 'docx@1.0.0',
        chunkerVersion: CHUNKER_VERSION,
        allowedUserIds: ['user-1'],
        allowedGroupIds: ['course-12-students'],
        isActive: true,
      });
      expect(item.chunkId).toMatch(/^[0-9a-f]{64}$/);
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('numbers chunks sequentially with the total count', () => {
    const chunks = chunk(doc);
    expect(chunks.map((item) => item.chunkNumber)).toEqual(chunks.map((_item, index) => index + 1));
    expect(chunks.every((item) => item.chunkCount === chunks.length)).toBe(true);
  });
});

describe('chunking options', () => {
  it.each([
    [{ targetTokens: 50, maxTokens: 40, minTokens: 10, overlapTokens: 5 }],
    [{ targetTokens: 50, maxTokens: 60, minTokens: 50, overlapTokens: 5 }],
    [{ targetTokens: 50, maxTokens: 60, minTokens: 10, overlapTokens: 30 }],
    [{ targetTokens: 50, maxTokens: 60, minTokens: 0, overlapTokens: 5 }],
  ])('rejects inconsistent options %j', (options) => {
    expect(() => new StructuredChunker(options, wordCounter)).toThrow(ChunkingError);
  });
});
