import type { ExtractionMetadata, ExtractionResult, TextBlockKind } from '../extractors/types.js';

/*
 * Prepares extracted blocks for chunking: renders each block as a unit of lightly marked-up
 * text (so the model can see structure), removes PDF page furniture and immediate duplicates,
 * and records each unit's heading context. Deterministic: the same blocks give the same units.
 */

export type ExtractedDocument = Extract<ExtractionResult, { status: 'extracted' }>;

export interface ContentUnit {
  /** Position in the normalised document (0-based); stable for identical input. */
  readonly index: number;
  readonly kind: TextBlockKind;
  /** Rendered text, e.g. `## Aftercare`, `- Apply twice daily`, `Speaker notes: …`. */
  readonly text: string;
  readonly headingLevel: number | undefined;
  /** Headings that enclose this unit; for a heading, its ancestors plus itself. */
  readonly contextPath: readonly string[];
  readonly pageNumber: number | undefined;
  readonly slideNumber: number | undefined;
}

export interface NormalizedDocument {
  readonly metadata: ExtractionMetadata;
  readonly sourceContentHash: string;
  readonly extractorVersion: string;
  readonly units: readonly ContentUnit[];
  /** The shallowest heading level present; headings at this level start a document section. */
  readonly topHeadingLevel: number | undefined;
  readonly removed: { readonly pageFurniture: number; readonly duplicates: number };
}

const FURNITURE_MAX_CHARS = 120;
const FURNITURE_MIN_PAGES = 3;
const FURNITURE_PAGE_SHARE = 0.5;
const PAGE_NUMBER_LINE = /^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

function render(kind: TextBlockKind, text: string, headingLevel: number | undefined): string {
  switch (kind) {
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(headingLevel ?? 1, 1), 6))} ${text}`;
    case 'list-item':
      return `- ${text}`;
    case 'speaker-notes':
      return `Speaker notes: ${text}`;
    case 'paragraph':
    case 'table-row':
    case 'preformatted':
      return text;
  }
}

/**
 * Text that repeats on many PDF pages (running headers/footers, "Confidential", page numbers)
 * is noise in every chunk. Only short paragraphs are considered, and only when they appear on
 * at least 3 pages and on at least half of all pages.
 */
function findPageFurniture(document: ExtractedDocument): ReadonlySet<string> {
  if (document.resourceType !== 'pdf') {
    return new Set();
  }
  const pages = new Set(
    document.blocks.map((block) => block.pageNumber).filter((page) => page !== undefined),
  );
  const pagesByText = new Map<string, Set<number>>();
  for (const block of document.blocks) {
    if (
      block.kind !== 'paragraph' ||
      block.pageNumber === undefined ||
      block.text.length > FURNITURE_MAX_CHARS
    ) {
      continue;
    }
    const key = block.text.toLowerCase();
    const seen = pagesByText.get(key) ?? new Set<number>();
    seen.add(block.pageNumber);
    pagesByText.set(key, seen);
  }
  const furniture = new Set<string>();
  for (const [text, seenOn] of pagesByText) {
    if (seenOn.size >= FURNITURE_MIN_PAGES && seenOn.size >= pages.size * FURNITURE_PAGE_SHARE) {
      furniture.add(text);
    }
  }
  return furniture;
}

export function normalizeContent(document: ExtractedDocument): NormalizedDocument {
  const furniture = findPageFurniture(document);
  const units: ContentUnit[] = [];
  let pageFurniture = 0;
  let duplicates = 0;

  for (const block of document.blocks) {
    const isPdfParagraph = document.resourceType === 'pdf' && block.kind === 'paragraph';
    if (
      isPdfParagraph &&
      (furniture.has(block.text.toLowerCase()) || PAGE_NUMBER_LINE.test(block.text))
    ) {
      pageFurniture += 1;
      continue;
    }
    const text = render(block.kind, block.text, block.headingLevel);
    const previous = units.at(-1);
    if (
      previous?.text === text &&
      previous.pageNumber === block.pageNumber &&
      previous.slideNumber === block.slideNumber
    ) {
      duplicates += 1;
      continue;
    }
    units.push({
      index: units.length,
      kind: block.kind,
      text,
      headingLevel: block.headingLevel,
      contextPath:
        block.kind === 'heading' ? [...block.headingPath, block.text] : [...block.headingPath],
      pageNumber: block.pageNumber,
      slideNumber: block.slideNumber,
    });
  }

  const headingLevels = units.flatMap((unit) =>
    unit.kind === 'heading' && unit.headingLevel !== undefined ? [unit.headingLevel] : [],
  );
  const metadata: ExtractionMetadata = {
    courseId: document.courseId,
    courseName: document.courseName,
    sectionId: document.sectionId,
    sectionName: document.sectionName,
    moduleId: document.moduleId,
    moduleName: document.moduleName,
    resourceId: document.resourceId,
    resourceName: document.resourceName,
    resourceType: document.resourceType,
    fileName: document.fileName,
    mimeType: document.mimeType,
    declaredMimeType: document.declaredMimeType,
    detectedContentType: document.detectedContentType,
    sourceUrl: document.sourceUrl,
    moduleUrl: document.moduleUrl,
    modifiedAt: document.modifiedAt,
    byteLength: document.byteLength,
  };
  return {
    metadata,
    sourceContentHash: document.contentHash,
    extractorVersion: `${document.extractor.name}@${document.extractor.version}`,
    units,
    topHeadingLevel: headingLevels.length === 0 ? undefined : Math.min(...headingLevels),
    removed: { pageFurniture, duplicates },
  };
}
