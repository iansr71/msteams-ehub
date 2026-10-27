import { describe, expect, it } from 'vitest';

import {
  buildZip,
  input,
  loadBinary,
  minimalDocx,
  testContext,
  testResource,
} from './__fixtures__/helpers.js';
import { docxExtractor } from './docxExtractor.js';
import { ExtractionFailure } from './errors.js';

const candidate = { resource: testResource(), contentType: 'docx' as const };
const run = (bytes: Uint8Array, limits = {}) =>
  docxExtractor.extract(candidate, input(bytes), testContext(limits));

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractionFailure);
    return (error as ExtractionFailure).reason;
  }
  throw new Error('expected failure');
}

const p = (text: string, props = '') =>
  `<w:p>${props === '' ? '' : `<w:pPr>${props}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe('docxExtractor', () => {
  it('extracts headings, paragraphs, list items and tables from a real Word document', async () => {
    const { blocks, warnings } = await run(loadBinary('sample.docx'));
    expect(warnings).toEqual([]);
    expect(
      blocks.map((block) => [
        block.kind,
        block.headingLevel ?? null,
        block.headingPath.join(' > '),
        block.text,
      ]),
    ).toEqual([
      ['heading', 1, '', 'Aftercare guide'],
      ['paragraph', null, 'Aftercare guide', 'Follow these steps after every chemical peel.'],
      ['heading', 2, 'Aftercare guide', 'First 24 hours'],
      [
        'list-item',
        null,
        'Aftercare guide > First 24 hours',
        'Apply the recommended moisturiser twice daily.',
      ],
      ['list-item', null, 'Aftercare guide > First 24 hours', 'Avoid makeup on treated areas.'],
      ['heading', 2, 'Aftercare guide', 'Products'],
      ['table-row', null, 'Aftercare guide > Products', 'Product | Use'],
      ['table-row', null, 'Aftercare guide > Products', 'Gentle cleanser | Morning and evening'],
      [
        'paragraph',
        null,
        'Aftercare guide > Products',
        'Contact the branch if redness lasts more than three days.',
      ],
    ]);
  });

  it('returns no blocks for an empty document', async () => {
    expect((await run(loadBinary('empty.docx'))).blocks).toEqual([]);
  });

  it('uses outline levels when there is no styles part', async () => {
    const { blocks } = await run(
      minimalDocx(
        `${p('Top', '<w:outlineLvl w:val="0"/>')}${p('Sub', '<w:outlineLvl w:val="1"/>')}${p('Body')}`,
      ),
    );
    expect(
      blocks.map((block) => [block.kind, block.headingLevel ?? null, block.headingPath]),
    ).toEqual([
      ['heading', 1, []],
      ['heading', 2, ['Top']],
      ['paragraph', null, ['Top', 'Sub']],
    ]);
  });

  it('skips hidden text, tracked deletions and field codes', async () => {
    const body =
      '<w:p><w:r><w:t>Visible </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden instruction</w:t></w:r>' +
      '<w:del><w:r><w:delText>deleted text</w:delText></w:r></w:del>' +
      '<w:r><w:instrText>HYPERLINK "https://evil.example.test"</w:instrText></w:r>' +
      '<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>shown.</w:t></w:r></w:p>';
    const { blocks, warnings } = await run(minimalDocx(body));
    expect(blocks.map((block) => block.text)).toEqual(['Visible shown.']);
    expect(warnings).toEqual(['hidden_text_skipped']);
  });

  it('folds nested tables into the enclosing cell', async () => {
    const cell = (inner: string) => `<w:tc>${inner}</w:tc>`;
    const body = `<w:tbl><w:tr>${cell(p('Outer'))}${cell(`<w:tbl><w:tr>${cell(p('In A'))}${cell(p('In B'))}</w:tr></w:tbl>`)}</w:tr></w:tbl>`;
    const { blocks } = await run(minimalDocx(body));
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ['table-row', 'Outer | In A | In B'],
    ]);
  });

  it('rejects a document part with a DOCTYPE (entity expansion attack)', async () => {
    const bomb = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      {
        name: 'word/document.xml',
        data: '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><w:document><w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);
    expect(await reasonOf(run(bomb))).toBe('corrupt');
  });

  it('rejects malformed XML and excessive nesting', async () => {
    expect(await reasonOf(run(minimalDocx('<w:p><w:r><w:t>unclosed')))).toBe('corrupt');
    const deep = `${'<w:sdt>'.repeat(300)}${'</w:sdt>'.repeat(300)}`;
    expect(await reasonOf(run(minimalDocx(deep)))).toBe('corrupt');
  });

  it('reports a package without a document part as corrupt', async () => {
    expect(await reasonOf(run(buildZip([{ name: '[Content_Types].xml', data: '<Types/>' }])))).toBe(
      'corrupt',
    );
  });

  it('reports a non-ZIP (encrypted OLE) file as corrupt when called directly', async () => {
    expect(await reasonOf(run(loadBinary('encrypted.docx')))).toBe('corrupt');
  });

  it('does not follow a main-part relationship that escapes the package', async () => {
    const archive = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      {
        name: '_rels/.rels',
        data: '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="../../etc/passwd"/></Relationships>',
      },
      {
        name: 'word/document.xml',
        data: `<w:document><w:body>${p('Safe fallback.')}</w:body></w:document>`,
      },
    ]);
    expect((await run(archive)).blocks.map((block) => block.text)).toEqual(['Safe fallback.']);
  });

  it('truncates at the text limit', async () => {
    const { blocks, warnings } = await run(
      minimalDocx(`${p('a'.repeat(700))}${p('b'.repeat(700))}`),
      { maxTextChars: 1000 },
    );
    expect(warnings).toEqual(['text_truncated']);
    expect(blocks.reduce((sum, block) => sum + block.text.length, 0)).toBe(1000);
  });
});
