import type { Deadline } from './deadline.js';
import { openSafeZip } from './safeZip.js';
import type { ApprovedContentType, ExtractionLimits } from './types.js';
import { decodeXmlBytes, parseXml } from './xml.js';

/*
 * Determines what a file really is from its bytes. The file name and declared MIME type are
 * never trusted: a ".pdf" that is really HTML is treated as HTML, and an executable renamed to
 * ".docx" is refused.
 */

export type DetectedContentType =
  | ApprovedContentType
  /** Word or PowerPoint document with macros (docm, pptm, …); never processed. */
  | 'ooxml-macro'
  /** Password-protected Office document (OLE container with an EncryptionInfo stream). */
  | 'ole-encrypted'
  /** Legacy binary Office format (doc, ppt, xls). */
  | 'ole-legacy'
  /** A ZIP that is not a supported OOXML document (xlsx, plain archive, …). */
  | 'zip-other'
  | 'binary'
  | 'empty';

export const MIME_TYPES: Readonly<Record<ApprovedContentType, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
  'plain-text': 'text/plain',
};

const OOXML_MAIN_PARTS: Readonly<Record<string, DetectedContentType>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml': 'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml': 'docx',
  'application/vnd.ms-word.document.macroenabled.main+xml': 'ooxml-macro',
  'application/vnd.ms-word.template.macroenabledtemplate.main+xml': 'ooxml-macro',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml': 'pptx',
  'application/vnd.ms-powerpoint.presentation.macroenabled.main+xml': 'ooxml-macro',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml': 'ooxml-macro',
  'application/vnd.ms-powerpoint.template.macroenabled.main+xml': 'ooxml-macro',
};

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** The PDF spec allows junk before the header; readers accept it within the first 1 KB. */
const PDF_HEADER_WINDOW = 1024;
const SNIFF_WINDOW = 8192;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function findSignature(bytes: Uint8Array, signature: readonly number[], window: number): boolean {
  const limit = Math.min(bytes.length - signature.length, window);
  for (let offset = 0; offset <= limit; offset += 1) {
    if (startsWith(bytes, signature, offset)) {
      return true;
    }
  }
  return false;
}

function containsUtf16(bytes: Uint8Array, text: string): boolean {
  const needle = Buffer.from(text, 'utf16le');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(needle);
}

/** Decodes the leading bytes as text, or returns undefined when they look binary. */
export function sniffText(bytes: Uint8Array): string | undefined {
  const head = bytes.subarray(0, SNIFF_WINDOW);
  if (head[0] === 0xff && head[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(head.subarray(2));
  }
  if (head[0] === 0xfe && head[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(head.subarray(2));
  }
  let controls = 0;
  for (const byte of head) {
    if (byte === 0) {
      return undefined;
    }
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controls += 1;
    }
  }
  if (controls > head.length * 0.05) {
    return undefined;
  }
  return new TextDecoder('utf-8').decode(head);
}

const HTML_MARKERS =
  /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])|<(?:p|div|h[1-6]|table|ul|ol|li|span|br|section|article)[\s/>]/i;

export function looksLikeHtml(text: string): boolean {
  return HTML_MARKERS.test(text.replace(/^\ufeff/, ''));
}

async function detectZip(
  bytes: Uint8Array,
  limits: ExtractionLimits,
  deadline: Deadline,
): Promise<DetectedContentType> {
  const zip = await openSafeZip(bytes, limits, deadline);
  try {
    if (!zip.has('[Content_Types].xml')) {
      return 'zip-other';
    }
    // Macro code can sit in any OOXML package regardless of the declared main part type.
    if ([...zip.entryNames].some((name) => /(^|\/)vbaProject\.bin$/i.test(name))) {
      return 'ooxml-macro';
    }
    let detected: DetectedContentType = 'zip-other';
    parseXml(
      decodeXmlBytes(await zip.read('[Content_Types].xml')),
      {
        open: (element) => {
          if (element.name !== 'Override') {
            return;
          }
          const contentType = (element.attributes['ContentType'] ?? '').toLowerCase();
          const mapped = OOXML_MAIN_PARTS[contentType];
          if (mapped !== undefined && detected !== 'ooxml-macro') {
            detected = mapped;
          }
        },
      },
      { maxDepth: limits.maxXmlDepth, deadline },
    );
    return detected;
  } finally {
    zip.close();
  }
}

export async function detectContentType(
  bytes: Uint8Array,
  limits: ExtractionLimits,
  deadline: Deadline,
): Promise<DetectedContentType> {
  if (bytes.length === 0) {
    return 'empty';
  }
  if (findSignature(bytes, PDF_SIGNATURE, PDF_HEADER_WINDOW)) {
    return 'pdf';
  }
  if (startsWith(bytes, ZIP_SIGNATURE)) {
    return detectZip(bytes, limits, deadline);
  }
  if (startsWith(bytes, OLE_SIGNATURE)) {
    return containsUtf16(bytes, 'EncryptionInfo') ? 'ole-encrypted' : 'ole-legacy';
  }
  const text = sniffText(bytes);
  if (text === undefined) {
    return 'binary';
  }
  if (text.trim() === '') {
    return 'empty';
  }
  return looksLikeHtml(text) ? 'html' : 'plain-text';
}
