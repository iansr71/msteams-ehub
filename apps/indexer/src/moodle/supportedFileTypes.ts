/**
 * File types the extraction phase (phase 4) is planned to handle. Discovery uses this to
 * label files as supported candidates; it is a prediction from Moodle's declared metadata,
 * not a guarantee — extraction must still detect the real type from the bytes.
 */
export const SUPPORTED_FILE_TYPES = [
  { type: 'pdf', mimeTypes: ['application/pdf'], extensions: ['pdf'] },
  { type: 'plain-text', mimeTypes: ['text/plain'], extensions: ['txt'] },
  { type: 'html', mimeTypes: ['text/html', 'application/xhtml+xml'], extensions: ['html', 'htm'] },
  {
    type: 'docx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    extensions: ['docx'],
  },
  {
    type: 'pptx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    extensions: ['pptx'],
  },
] as const;

export type SupportedFileType = (typeof SUPPORTED_FILE_TYPES)[number]['type'];

// Moodle reports these when it cannot identify a file; the extension is used instead.
const GENERIC_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'document/unknown',
  'application/x-unknown',
]);

function normalizeMime(mimeType: string | undefined): string | undefined {
  const base = mimeType?.split(';')[0]?.trim().toLowerCase();
  return base === undefined || base === '' ? undefined : base;
}

function extensionOf(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 || dot === fileName.length - 1
    ? undefined
    : fileName.slice(dot + 1).toLowerCase();
}

/**
 * A specific declared MIME type decides; a missing or generic one falls back to the extension.
 * So `report.pdf` declared as `image/png` is unsupported, while `report.pdf` declared as
 * `application/octet-stream` is a PDF candidate.
 */
export function detectSupportedFileType(
  fileName: string,
  mimeType: string | undefined,
): SupportedFileType | undefined {
  const mime = normalizeMime(mimeType);
  if (mime !== undefined && !GENERIC_MIME_TYPES.has(mime)) {
    return SUPPORTED_FILE_TYPES.find((entry) =>
      (entry.mimeTypes as readonly string[]).includes(mime),
    )?.type;
  }
  const extension = extensionOf(fileName);
  if (extension === undefined) {
    return undefined;
  }
  return SUPPORTED_FILE_TYPES.find((entry) =>
    (entry.extensions as readonly string[]).includes(extension),
  )?.type;
}
