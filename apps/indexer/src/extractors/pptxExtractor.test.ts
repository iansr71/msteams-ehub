import { describe, expect, it } from 'vitest';

import {
  input,
  loadBinary,
  minimalPptx,
  testContext,
  testResource,
} from './__fixtures__/helpers.js';
import { ExtractionFailure } from './errors.js';
import { pptxExtractor } from './pptxExtractor.js';

const candidate = { resource: testResource(), contentType: 'pptx' as const };
const run = (bytes: Uint8Array, limits = {}) =>
  pptxExtractor.extract(candidate, input(bytes), testContext(limits));

describe('pptxExtractor', () => {
  it('extracts slide titles, bullets and speaker notes with slide numbers', async () => {
    const { blocks, warnings } = await run(loadBinary('sample.pptx'));
    expect(warnings).toEqual(['slides_without_text']);
    expect(
      blocks.map((block) => [
        block.kind,
        block.slideNumber,
        block.headingPath.join(' > '),
        block.text,
      ]),
    ).toEqual([
      ['heading', 1, '', 'Branch induction'],
      ['paragraph', 1, 'Branch induction', 'Welcome to Skin Renewal training.'],
      ['speaker-notes', 1, 'Branch induction', 'Presenter note for Branch induction.'],
      ['heading', 2, '', 'Opening procedure'],
      ['paragraph', 2, 'Opening procedure', 'Disarm the alarm.'],
      ['paragraph', 2, 'Opening procedure', 'Switch on treatment devices.'],
      ['paragraph', 2, 'Opening procedure', "Check the day's bookings."],
      ['speaker-notes', 2, 'Opening procedure', 'Presenter note for Opening procedure.'],
      ['heading', 3, '', 'Closing procedure'],
      ['paragraph', 3, 'Closing procedure', 'Complete the cash-up.'],
      ['paragraph', 3, 'Closing procedure', 'Arm the alarm.'],
      ['speaker-notes', 3, 'Closing procedure', 'Presenter note for Closing procedure.'],
    ]);
  });

  it('orders slides by the presentation, not by part file names', async () => {
    const deck = minimalPptx(
      [{ title: 'First' }, { title: 'Second' }, { title: 'Third' }],
      [3, 1, 2],
    );
    const { blocks } = await run(deck);
    expect(blocks.map((block) => [block.slideNumber, block.text])).toEqual([
      [1, 'First'],
      [2, 'Second'],
      [3, 'Third'],
    ]);
  });

  it('puts the title first even when it is not the first shape', async () => {
    const { blocks } = await run(minimalPptx([{ title: 'Title', body: ['Body text'] }]));
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph']);
  });

  it('skips hidden slides but keeps slide numbering', async () => {
    const { blocks, warnings } = await run(
      minimalPptx([{ title: 'One' }, { title: 'Draft', hidden: true }, { title: 'Three' }]),
    );
    expect(blocks.map((block) => [block.slideNumber, block.text])).toEqual([
      [1, 'One'],
      [3, 'Three'],
    ]);
    expect(warnings).toEqual(['hidden_slides_skipped']);
  });

  it('extracts slide tables and ignores notes-page furniture', async () => {
    const { blocks } = await run(
      minimalPptx([
        {
          title: 'Prices',
          tableRows: [
            ['Peel', 'R900'],
            ['Laser', 'R1500'],
          ],
          notes: 'Check current list.',
        },
      ]),
    );
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ['heading', 'Prices'],
      ['table-row', 'Peel | R900'],
      ['table-row', 'Laser | R1500'],
      ['speaker-notes', 'Check current list.'],
    ]);
  });

  it('never follows external relationships', async () => {
    // The fixture presentation rels include an External hyperlink; extraction must not touch it.
    const { blocks } = await run(minimalPptx([{ title: 'Safe' }]));
    expect(blocks.map((block) => block.text)).toEqual(['Safe']);
  });

  it('reports a package without a presentation part as corrupt', async () => {
    const { buildZip } = await import('./__fixtures__/helpers.js');
    await expect(
      run(buildZip([{ name: '[Content_Types].xml', data: '<Types/>' }])),
    ).rejects.toBeInstanceOf(ExtractionFailure);
  });

  it('truncates at the text limit', async () => {
    const { warnings } = await run(
      minimalPptx([{ title: 'a'.repeat(600) }, { title: 'b'.repeat(600) }]),
      { maxTextChars: 1000 },
    );
    expect(warnings).toContain('text_truncated');
  });
});
