import { describe, expect, it } from 'vitest';

import {
  buildZip,
  CONTENT_TYPES_DOCX,
  loadBinary,
  minimalDocx,
  minimalPptx,
  testLimits,
} from './__fixtures__/helpers.js';
import { detectContentType, looksLikeHtml, sniffText } from './contentTypeDetector.js';
import { Deadline } from './deadline.js';

const detect = (bytes: Uint8Array | string) =>
  detectContentType(
    typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
    testLimits(),
    new Deadline(30_000),
  );

describe('detectContentType', () => {
  it.each([
    ['sample.pdf', 'pdf'],
    ['encrypted.pdf', 'pdf'],
    ['sample.docx', 'docx'],
    ['sample.pptx', 'pptx'],
    ['encrypted.docx', 'ole-encrypted'],
  ])('detects %s as %s from its bytes', async (name, expected) => {
    expect(await detect(loadBinary(name))).toBe(expected);
  });

  it('finds a PDF header after leading junk, as PDF readers do', async () => {
    expect(await detect(`junk bytes\n%PDF-1.4\n...`)).toBe('pdf');
  });

  it('identifies OOXML by its declared main part, not the extension', async () => {
    expect(await detect(minimalDocx('<w:p/>'))).toBe('docx');
    expect(await detect(minimalPptx([{ title: 'x' }]))).toBe('pptx');
  });

  it('flags macro-enabled documents by content type or embedded VBA project', async () => {
    const docm = minimalDocx(
      '<w:p/>',
      [],
      CONTENT_TYPES_DOCX.replace(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        'application/vnd.ms-word.document.macroEnabled.main+xml',
      ),
    );
    expect(await detect(docm)).toBe('ooxml-macro');
    expect(
      await detect(
        minimalDocx('<w:p/>', [{ name: 'word/vbaProject.bin', data: 'Attribute VB_Name' }]),
      ),
    ).toBe('ooxml-macro');
  });

  it('treats other ZIPs (spreadsheets, archives) as unsupported', async () => {
    expect(await detect(buildZip([{ name: 'readme.txt', data: 'hi' }]))).toBe('zip-other');
    const xlsx = buildZip([
      {
        name: '[Content_Types].xml',
        data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      },
    ]);
    expect(await detect(xlsx)).toBe('zip-other');
  });

  it('distinguishes legacy Office files from encrypted ones', async () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(await detect(ole)).toBe('ole-legacy');
  });

  it('detects HTML and plain text', async () => {
    expect(await detect('<!DOCTYPE html><html><body>x</body></html>')).toBe('html');
    expect(await detect('  <p>Fragment from a Moodle page</p>')).toBe('html');
    expect(await detect('Just some notes.\nSecond line.')).toBe('plain-text');
    expect(await detect('Price < 5 and > 2')).toBe('plain-text');
  });

  it('treats a renamed binary as binary, whatever its name', async () => {
    const executable = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // "MZ" header
    expect(await detect(executable)).toBe('binary');
    expect(
      await detect(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])),
    ).toBe('binary');
  });

  it('detects empty and whitespace-only input', async () => {
    expect(await detect(new Uint8Array())).toBe('empty');
    expect(await detect('   \n\t ')).toBe('empty');
  });
});

describe('sniffText and looksLikeHtml', () => {
  it('rejects text with NUL bytes or many control characters', () => {
    expect(sniffText(new Uint8Array([0x41, 0x00, 0x42]))).toBeUndefined();
    expect(sniffText(new Uint8Array(Array.from({ length: 100 }, () => 0x01)))).toBeUndefined();
    expect(sniffText(new TextEncoder().encode('plain'))).toBe('plain');
  });

  it('recognises common HTML openings', () => {
    expect(looksLikeHtml('\ufeff<html lang="en">')).toBe(true);
    expect(looksLikeHtml('<h2>Title</h2>')).toBe(true);
    expect(looksLikeHtml('a <b> c')).toBe(false);
  });
});
