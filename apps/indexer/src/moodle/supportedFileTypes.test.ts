import { describe, expect, it } from 'vitest';

import { detectSupportedFileType } from './supportedFileTypes.js';

describe('detectSupportedFileType', () => {
  it.each([
    ['a.pdf', 'application/pdf', 'pdf'],
    ['a.PDF', 'application/pdf; charset=binary', 'pdf'],
    ['a.txt', 'text/plain', 'plain-text'],
    ['a.htm', 'text/html', 'html'],
    ['a.xhtml', 'application/xhtml+xml', 'html'],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ])('recognises %s (%s) as %s', (name, mime, expected) => {
    expect(detectSupportedFileType(name, mime)).toBe(expected);
  });

  it.each([
    ['notes.txt', undefined, 'plain-text'],
    ['report.pdf', 'application/octet-stream', 'pdf'],
    ['deck.pptx', 'document/unknown', 'pptx'],
  ])('falls back to the extension for %s with generic MIME %s', (name, mime, expected) => {
    expect(detectSupportedFileType(name, mime)).toBe(expected);
  });

  it.each([
    ['report.pdf', 'image/png'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['old.doc', 'application/msword'],
    ['clip.mp4', 'video/mp4'],
    ['noextension', undefined],
    ['.pdf', undefined],
    ['trailingdot.', undefined],
  ])('does not support %s (%s)', (name, mime) => {
    expect(detectSupportedFileType(name, mime)).toBeUndefined();
  });
});
