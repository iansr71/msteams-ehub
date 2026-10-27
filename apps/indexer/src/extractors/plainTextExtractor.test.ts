import { describe, expect, it } from 'vitest';

import { input, testContext, testResource } from './__fixtures__/helpers.js';
import { plainTextExtractor } from './plainTextExtractor.js';

const run = (bytes: Uint8Array | string, limits = {}) =>
  plainTextExtractor.extract(
    { resource: testResource(), contentType: 'plain-text' },
    input(bytes),
    testContext(limits),
  );

describe('plainTextExtractor', () => {
  it('splits paragraphs on blank lines and joins hard-wrapped lines', async () => {
    const { blocks, warnings } = await run(
      'First line\nwrapped here.\r\n\r\nSecond paragraph.\n\n\n   \nThird.',
    );
    expect(warnings).toEqual([]);
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ['paragraph', 'First line wrapped here.'],
      ['paragraph', 'Second paragraph.'],
      ['paragraph', 'Third.'],
    ]);
  });

  it('honours UTF-8 and UTF-16 byte-order marks', async () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Crème')]);
    expect((await run(utf8)).blocks[0]?.text).toBe('Crème');

    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('Ünïcode', 'utf16le')]);
    expect((await run(utf16)).blocks[0]?.text).toBe('Ünïcode');
  });

  it('falls back to Windows-1252 for non-UTF-8 text, with a warning', async () => {
    const { blocks, warnings } = await run(new Uint8Array([0x43, 0x61, 0x66, 0xe9])); // "Café" in 1252
    expect(blocks[0]?.text).toBe('Café');
    expect(warnings).toEqual(['decoded_as_windows_1252']);
  });

  it('truncates at the text limit', async () => {
    const { blocks, warnings } = await run(`${'x'.repeat(900)}\n\n${'y'.repeat(900)}`, {
      maxTextChars: 1000,
    });
    expect(warnings).toEqual(['text_truncated']);
    expect(blocks.map((block) => block.text.length)).toEqual([900, 100]);
  });

  it('returns no blocks for whitespace-only text', async () => {
    expect((await run(' \n\n \t ')).blocks).toEqual([]);
  });
});
