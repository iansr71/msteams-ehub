export interface DecodedText {
  readonly text: string;
  /** Set when the bytes were not valid UTF-8 and a fallback encoding was used. */
  readonly warning: string | undefined;
}

/**
 * Decodes a text or HTML file: honours UTF-8/UTF-16 byte-order marks, otherwise requires valid
 * UTF-8 and falls back to Windows-1252 (common for files saved on Windows) with a warning.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), warning: undefined };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), warning: undefined };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), warning: undefined };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), warning: undefined };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      warning: 'decoded_as_windows_1252',
    };
  }
}
