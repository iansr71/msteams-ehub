import { finalizeOutput, sanitizeText } from '../moodle/diagnosticOutput.js';
import type { ChunkingOptions } from './chunkContent.js';
import { CHUNKER_VERSION, type ContentChunk } from './chunkMetadata.js';
import type { NormalizedDocument } from './normalizeContent.js';

/*
 * Diagnostic view of a chunking run for chunk:test. Shows chunk numbers, token counts and source
 * metadata. Chunk text is never included unless a short per-chunk preview is explicitly asked for.
 */

export const CHUNK_PREVIEW_CHARS = 60;
const HEADING_PATH_CHARS = 60;

export interface ChunkRow {
  readonly chunkNumber: number;
  readonly chunkId: string;
  readonly tokenCount: number;
  readonly overlapTokens: number;
  readonly pageNumber?: number;
  readonly pageNumberEnd?: number;
  readonly slideNumber?: number;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly contentHash: string;
  readonly preview?: string;
}

export interface ChunkingDiagnostic {
  readonly status: 'chunked';
  readonly resource: {
    readonly courseId: number;
    readonly courseName: string;
    readonly courseCategory: string | undefined;
    readonly sectionId: number;
    readonly sectionName: string;
    readonly moduleId: number;
    readonly moduleName: string;
    readonly resourceId: string;
    readonly resourceName: string;
    readonly resourceType: string | undefined;
    readonly fileName: string;
    readonly mimeType: string | undefined;
    readonly sourceUrl: string | undefined;
    readonly moduleUrl: string | undefined;
    readonly modifiedAt: string | undefined;
    readonly sourceContentHash: string;
    readonly extractorVersion: string;
  };
  readonly settings: ChunkingOptions & {
    readonly tokenizer: string;
    readonly chunkerVersion: string;
    readonly tenantId: string;
  };
  readonly statistics: {
    readonly chunks: number;
    readonly totalTokens: number;
    readonly minTokens: number;
    readonly meanTokens: number;
    readonly maxTokens: number;
    readonly belowMinimum: number;
    readonly withOverlap: number;
    readonly removedPageFurniture: number;
    readonly removedDuplicates: number;
  };
  readonly chunks: readonly ChunkRow[];
  readonly notes: readonly string[];
}

export function toChunkingDiagnostic(
  document: NormalizedDocument,
  chunks: readonly ContentChunk[],
  settings: ChunkingOptions & { readonly tokenizer: string; readonly tenantId: string },
  options: {
    readonly courseCategory: string | undefined;
    readonly includePreview: boolean;
    readonly notes: readonly string[];
  },
): ChunkingDiagnostic {
  const tokens = chunks.map((chunk) => chunk.tokenCount);
  const total = tokens.reduce((sum, count) => sum + count, 0);
  const metadata = document.metadata;
  return {
    status: 'chunked',
    resource: {
      courseId: metadata.courseId,
      courseName: metadata.courseName,
      courseCategory: options.courseCategory,
      sectionId: metadata.sectionId,
      sectionName: metadata.sectionName,
      moduleId: metadata.moduleId,
      moduleName: metadata.moduleName,
      resourceId: metadata.resourceId,
      resourceName: metadata.resourceName,
      resourceType: metadata.resourceType,
      fileName: metadata.fileName,
      mimeType: metadata.mimeType,
      sourceUrl: metadata.sourceUrl,
      moduleUrl: metadata.moduleUrl,
      modifiedAt: metadata.modifiedAt,
      sourceContentHash: document.sourceContentHash,
      extractorVersion: document.extractorVersion,
    },
    settings: { ...settings, chunkerVersion: CHUNKER_VERSION },
    statistics: {
      chunks: chunks.length,
      totalTokens: total,
      minTokens: tokens.length === 0 ? 0 : Math.min(...tokens),
      meanTokens: tokens.length === 0 ? 0 : Math.round(total / tokens.length),
      maxTokens: tokens.length === 0 ? 0 : Math.max(...tokens),
      belowMinimum: tokens.filter((count) => count < settings.minTokens).length,
      withOverlap: chunks.filter((chunk) => chunk.overlapTokens > 0).length,
      removedPageFurniture: document.removed.pageFurniture,
      removedDuplicates: document.removed.duplicates,
    },
    chunks: chunks.map((chunk) => ({
      chunkNumber: chunk.chunkNumber,
      chunkId: chunk.chunkId,
      tokenCount: chunk.tokenCount,
      overlapTokens: chunk.overlapTokens,
      ...(chunk.pageNumber === undefined ? {} : { pageNumber: chunk.pageNumber }),
      ...(chunk.pageNumberEnd === undefined ? {} : { pageNumberEnd: chunk.pageNumberEnd }),
      ...(chunk.slideNumber === undefined ? {} : { slideNumber: chunk.slideNumber }),
      title: sanitizeText(chunk.title, HEADING_PATH_CHARS),
      headingPath: chunk.headingPath.map((heading) => sanitizeText(heading, HEADING_PATH_CHARS)),
      contentHash: chunk.contentHash,
      ...(options.includePreview
        ? { preview: sanitizeText(chunk.content, CHUNK_PREVIEW_CHARS) }
        : {}),
    })),
    notes: options.notes,
  };
}

function location(row: ChunkRow): string {
  if (row.slideNumber !== undefined) {
    return `slide ${String(row.slideNumber)}`;
  }
  if (row.pageNumber !== undefined) {
    return row.pageNumberEnd === undefined
      ? `p${String(row.pageNumber)}`
      : `p${String(row.pageNumber)}-${String(row.pageNumberEnd)}`;
  }
  return '-';
}

export function renderChunkingText(diagnostic: ChunkingDiagnostic): string {
  const { resource: r, settings: s, statistics: st } = diagnostic;
  const lines = [
    `Chunking: ${String(st.chunks)} chunks (${s.chunkerVersion}, tokenizer ${s.tokenizer}; target ${String(s.targetTokens)} / max ${String(s.maxTokens)} / min ${String(s.minTokens)} / overlap ${String(s.overlapTokens)})`,
    `  Course:    ${String(r.courseId)} ${sanitizeText(r.courseName)}${r.courseCategory === undefined ? '' : ` (category ${r.courseCategory})`}`,
    `  Module:    ${String(r.moduleId)} ${sanitizeText(r.moduleName)}`,
    `  Resource:  ${sanitizeText(r.resourceId, 200)} ${sanitizeText(r.resourceName)} [${r.resourceType ?? '-'}]`,
    `  Source:    ${sanitizeText(r.sourceUrl, 300)}`,
    `  Extractor: ${r.extractorVersion}; source SHA-256 ${r.sourceContentHash.slice(0, 16)}…`,
    `  Tokens:    total ${String(st.totalTokens)}; per chunk min ${String(st.minTokens)} / mean ${String(st.meanTokens)} / max ${String(st.maxTokens)}; ${String(st.belowMinimum)} below minimum; ${String(st.withOverlap)} with overlap`,
    `  Removed:   ${String(st.removedPageFurniture)} page-furniture blocks, ${String(st.removedDuplicates)} duplicates`,
    '',
    '   #  Tokens  Overlap  Location  Chunk ID      Heading path',
  ];
  for (const row of diagnostic.chunks) {
    lines.push(
      `${String(row.chunkNumber).padStart(4)}  ${String(row.tokenCount).padStart(6)}  ${String(row.overlapTokens).padStart(7)}  ${location(row).padEnd(8)}  ${row.chunkId.slice(0, 12)}  ${row.headingPath.join(' > ') || '-'}`,
    );
    if (row.preview !== undefined) {
      lines.push(`        "${row.preview}"`);
    }
  }
  for (const note of diagnostic.notes) {
    lines.push('', `Note: ${note}`);
  }
  return finalizeOutput(lines.join('\n'));
}
