import { describe, expect, it } from 'vitest';

import { input, loadBinary, testContext, testResource } from './__fixtures__/helpers.js';
import { Deadline } from './deadline.js';
import { ExtractionFailure } from './errors.js';
import { pdfExtractor } from './pdfExtractor.js';

const candidate = { resource: testResource(), contentType: 'pdf' as const };

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractionFailure);
    return (error as ExtractionFailure).reason;
  }
  throw new Error('expected failure');
}

describe('pdfExtractor', () => {
  it('extracts text per page with page numbers and font-size headings', async () => {
    const { blocks, warnings } = await pdfExtractor.extract(
      candidate,
      input(loadBinary('sample.pdf')),
      testContext(),
    );
    expect(warnings).toEqual([]);
    expect(
      blocks.map((block) => [
        block.kind,
        block.headingLevel ?? null,
        block.pageNumber,
        block.headingPath.join(' > '),
        block.text,
      ]),
    ).toEqual([
      ['heading', 1, 1, '', 'Consultation checklist'],
      [
        'paragraph',
        null,
        1,
        'Consultation checklist',
        "Confirm the client's medical history before treatment.",
      ],
      ['paragraph', null, 1, 'Consultation checklist', 'Record allergies in the client profile.'],
      ['heading', 1, 2, '', 'Aftercare'],
      ['paragraph', null, 2, 'Aftercare', 'Advise the client to avoid direct sun for 48 hours.'],
      ['heading', 1, 3, '', 'Escalation'],
      ['paragraph', null, 3, 'Escalation', 'Contact the branch manager for any adverse reaction.'],
    ]);
  });

  it('does not modify the caller’s buffer', async () => {
    const bytes = loadBinary('sample.pdf');
    const copy = bytes.slice();
    await pdfExtractor.extract(candidate, input(bytes), testContext());
    expect(bytes.byteLength).toBe(copy.byteLength);
    expect(Buffer.from(bytes).equals(Buffer.from(copy))).toBe(true);
  });

  it('reports a password-protected PDF as encrypted', async () => {
    expect(
      await reasonOf(
        pdfExtractor.extract(candidate, input(loadBinary('encrypted.pdf')), testContext()),
      ),
    ).toBe('encrypted');
  });

  it('reports a truncated PDF as corrupt', async () => {
    const truncated = loadBinary('sample.pdf').slice(0, 900);
    expect(await reasonOf(pdfExtractor.extract(candidate, input(truncated), testContext()))).toBe(
      'corrupt',
    );
  });

  it('reports garbage after a PDF header as corrupt', async () => {
    expect(
      await reasonOf(
        pdfExtractor.extract(candidate, input('%PDF-1.7\nnot really a pdf'), testContext()),
      ),
    ).toBe('corrupt');
  });

  it('returns no blocks and a warning for a page without a text layer (scans need OCR)', async () => {
    const { blocks, warnings } = await pdfExtractor.extract(
      candidate,
      input(loadBinary('blank.pdf')),
      testContext(),
    );
    expect(blocks).toEqual([]);
    expect(warnings).toEqual(['pages_without_text']);
  });

  it('truncates at the text limit', async () => {
    const { blocks, warnings } = await pdfExtractor.extract(
      candidate,
      input(loadBinary('sample.pdf')),
      testContext({ maxTextChars: 60 }),
    );
    expect(warnings).toContain('text_truncated');
    expect(blocks.reduce((sum, block) => sum + block.text.length, 0)).toBeLessThanOrEqual(60);
  });

  it('stops between pages once the deadline has passed', async () => {
    let now = 0;
    const deadline = new Deadline(1_000, () => now);
    now = 5_000;
    const context = { ...testContext(), deadline };
    expect(
      await reasonOf(pdfExtractor.extract(candidate, input(loadBinary('sample.pdf')), context)),
    ).toBe('timeout');
  });
});
