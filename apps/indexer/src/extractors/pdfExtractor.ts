import type * as Pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api.js';

import { ExtractionFailure } from './errors.js';
import { BlockCollector, HeadingTracker, normalizeInlineText } from './textNormalization.js';
import type { ContentExtractor, ExtractorOutput } from './types.js';

/*
 * PDF text extraction with pdfjs-dist 6. That version never evaluates code derived from a
 * document: the eval-based PostScript compiler (the CVE-2024-4367 class) was removed, which is
 * why it no longer has an isEvalSupported option. tests/security/pdf-parser.test.ts guards this. It is configured to
 * never load fonts into the runtime, never render XFA forms and never fetch anything: the
 * document is passed in memory, and annotations, actions and embedded files are not read. Page numbers are preserved; headings
 * are inferred from font size, which is a heuristic (see docs/extraction.md).
 */

type PdfjsModule = typeof Pdfjs;

let pdfjsModule: Promise<PdfjsModule> | undefined;

/**
 * pdfjs prints warnings about the absent (deliberately excluded) canvas package while the module
 * initialises. stderr is the structured-log channel, so console output is muted for the import.
 */
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsModule ??= (async () => {
    /* eslint-disable no-console -- console is muted, not written to */
    const original = { log: console.log, warn: console.warn, error: console.error };
    const mute = (): void => undefined;
    Object.assign(console, { log: mute, warn: mute, error: mute });
    /* eslint-enable no-console */
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      Object.assign(console, original);
    }
  })();
  return pdfjsModule;
}

interface PdfLine {
  readonly pageNumber: number;
  readonly text: string;
  readonly size: number;
  readonly y: number;
}

function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return 'str' in item;
}

function linesFromItems(
  items: readonly (TextItem | TextMarkedContent)[],
  pageNumber: number,
): PdfLine[] {
  const lines: PdfLine[] = [];
  let text = '';
  let size = 0;
  let y: number | undefined;
  const push = (): void => {
    if (normalizeInlineText(text) !== '' && y !== undefined) {
      lines.push({ pageNumber, text, size: Math.round(size * 10) / 10, y });
    }
    text = '';
    size = 0;
    y = undefined;
  };
  for (const item of items) {
    if (!isTextItem(item)) {
      continue;
    }
    const itemY = Number(item.transform[5] ?? 0);
    if (y !== undefined && Math.abs(itemY - y) > Math.max(2, size * 0.5) && text !== '') {
      push();
    }
    text += item.str;
    if (item.str.trim() !== '') {
      size = Math.max(size, Math.abs(item.height));
      y ??= itemY;
    }
    if (item.hasEOL) {
      push();
    }
  }
  push();
  return lines;
}

/** The body font size is the size carrying the most characters. */
function bodySize(lines: readonly PdfLine[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    weights.set(line.size, (weights.get(line.size) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

const HEADING_SIZE_RATIO = 1.2;
const MAX_HEADING_CHARS = 150;
const MAX_HEADING_LEVELS = 3;

export const pdfExtractor: ContentExtractor = {
  name: 'pdf',
  version: '1.0.0',
  resourceType: 'pdf',
  supports: ({ contentType }) => contentType === 'pdf',
  extract: async (_candidate, input, context): Promise<ExtractorOutput> => {
    const pdfjs = await loadPdfjs();
    // pdfjs takes ownership of (and may detach) the buffer it is given.
    const data = new Uint8Array(input.bytes);
    const task = pdfjs.getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      stopAtErrors: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const onAbort = (): void => {
      void task.destroy();
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    try {
      let document: Awaited<typeof task.promise>;
      try {
        document = await task.promise;
      } catch (error) {
        if (error instanceof pdfjs.PasswordException) {
          throw new ExtractionFailure('encrypted', 'PDF is password protected.');
        }
        throw new ExtractionFailure('corrupt', 'PDF could not be parsed.');
      }

      const lines: PdfLine[] = [];
      let collectedChars = 0;
      let pagesWithoutText = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        context.deadline.check();
        let pageLines: PdfLine[];
        try {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent({ includeMarkedContent: false });
          pageLines = linesFromItems(content.items, pageNumber);
          page.cleanup();
        } catch (error) {
          if (error instanceof ExtractionFailure) {
            throw error;
          }
          throw new ExtractionFailure('corrupt', 'A PDF page could not be read.');
        }
        if (pageLines.length === 0) {
          pagesWithoutText += 1;
        }
        lines.push(...pageLines);
        collectedChars += pageLines.reduce((sum, line) => sum + line.text.length, 0);
        // Stop reading pages well past the text limit; the collector does the exact cut.
        if (collectedChars > context.limits.maxTextChars * 2) {
          break;
        }
      }

      const body = bodySize(lines);
      const headingSizes = [...new Set(lines.map((line) => line.size))]
        .filter((size) => body > 0 && size >= body * HEADING_SIZE_RATIO)
        .sort((a, b) => b - a);
      const levelFor = (line: PdfLine): number | undefined => {
        const rank = headingSizes.indexOf(line.size);
        return rank === -1 || normalizeInlineText(line.text).length > MAX_HEADING_CHARS
          ? undefined
          : Math.min(rank + 1, MAX_HEADING_LEVELS);
      };

      const collector = new BlockCollector(context.limits.maxTextChars);
      const headings = new HeadingTracker();
      let paragraph: string[] = [];
      let paragraphPage = 0;
      let previous: PdfLine | undefined;
      const flush = (): void => {
        if (paragraph.length > 0) {
          collector.add({
            kind: 'paragraph',
            text: paragraph.join(' '),
            headingPath: headings.path,
            pageNumber: paragraphPage,
          });
        }
        paragraph = [];
      };

      for (const line of lines) {
        const level = levelFor(line);
        if (level !== undefined) {
          flush();
          const path = headings.enter(level, line.text);
          collector.add({
            kind: 'heading',
            text: line.text,
            headingLevel: level,
            headingPath: path,
            pageNumber: line.pageNumber,
          });
        } else {
          const continues =
            previous !== undefined &&
            levelFor(previous) === undefined &&
            previous.pageNumber === line.pageNumber &&
            previous.y - line.y <= Math.max(line.size, previous.size) * 1.8;
          if (!continues) {
            flush();
            paragraphPage = line.pageNumber;
          }
          paragraph.push(line.text);
        }
        previous = line;
        if (collector.truncated) {
          break;
        }
      }
      flush();

      const warnings: string[] = [];
      if (pagesWithoutText > 0) {
        // Scanned pages have no text layer; OCR is out of scope.
        warnings.push('pages_without_text');
      }
      if (collector.truncated || collectedChars > context.limits.maxTextChars) {
        warnings.push('text_truncated');
      }
      return { blocks: collector.blocks, warnings };
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      await task.destroy();
    }
  },
};
