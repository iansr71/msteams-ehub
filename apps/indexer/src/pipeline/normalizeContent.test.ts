import { describe, expect, it } from 'vitest';

import { block, document, heading } from './__fixtures__/documents.js';
import { normalizeContent } from './normalizeContent.js';

describe('normalizeContent', () => {
  it('renders structure as light markup and records heading context', () => {
    const normalized = normalizeContent(
      document([
        heading('Guide', 1),
        block({ text: 'Intro.', path: ['Guide'] }),
        heading('Steps', 2, ['Guide']),
        block({ kind: 'list-item', text: 'Cleanse', path: ['Guide', 'Steps'] }),
        block({ kind: 'table-row', text: 'Peel | R900', path: ['Guide', 'Steps'] }),
        block({ kind: 'speaker-notes', text: 'Mention pricing.', path: ['Guide', 'Steps'] }),
      ]),
    );
    expect(normalized.units.map((unit) => [unit.text, unit.contextPath])).toEqual([
      ['# Guide', ['Guide']],
      ['Intro.', ['Guide']],
      ['## Steps', ['Guide', 'Steps']],
      ['- Cleanse', ['Guide', 'Steps']],
      ['Peel | R900', ['Guide', 'Steps']],
      ['Speaker notes: Mention pricing.', ['Guide', 'Steps']],
    ]);
    expect(normalized.topHeadingLevel).toBe(1);
    expect(normalized.extractorVersion).toBe('docx@1.0.0');
    expect(normalized.sourceContentHash).toBe('a'.repeat(64));
  });

  it('uses the shallowest heading level present as the section level', () => {
    expect(
      normalizeContent(document([heading('A', 3), heading('B', 2), block({ text: 'x' })]))
        .topHeadingLevel,
    ).toBe(2);
    expect(normalizeContent(document([block({ text: 'x' })])).topHeadingLevel).toBeUndefined();
  });

  it('removes running headers, footers and page numbers repeated across PDF pages', () => {
    const pages = [1, 2, 3, 4].flatMap((page) => [
      block({ text: 'Skin Renewal - Confidential', page }),
      block({ text: `Real content on page ${String(page)}.`, page }),
      block({ text: `Page ${String(page)} of 4`, page }),
    ]);
    const normalized = normalizeContent(document(pages, 'pdf'));
    expect(normalized.units.map((unit) => unit.text)).toEqual([
      'Real content on page 1.',
      'Real content on page 2.',
      'Real content on page 3.',
      'Real content on page 4.',
    ]);
    expect(normalized.removed.pageFurniture).toBe(8);
  });

  it('keeps text repeated on only a few pages, and leaves non-PDF documents alone', () => {
    const pdf = normalizeContent(
      document(
        [1, 2, 3, 4, 5, 6, 7].map((page) =>
          block({ text: page <= 2 ? 'Repeated note.' : `Body ${String(page)}.`, page }),
        ),
        'pdf',
      ),
    );
    expect(pdf.units.filter((unit) => unit.text === 'Repeated note.')).toHaveLength(2);

    const docx = normalizeContent(document([block({ text: '3' }), block({ text: 'Page 1 of 2' })]));
    expect(docx.units).toHaveLength(2);
  });

  it('drops an immediately repeated block at the same location', () => {
    const normalized = normalizeContent(
      document([heading('Title', 1), heading('Title', 1), block({ text: 'Body' })]),
    );
    expect(normalized.units.map((unit) => unit.text)).toEqual(['# Title', 'Body']);
    expect(normalized.removed.duplicates).toBe(1);
  });
});
