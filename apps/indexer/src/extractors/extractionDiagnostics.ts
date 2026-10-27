import type { CourseResource } from '../moodle/models.js';
import { finalizeOutput, formatBytes, sanitizeText } from '../moodle/diagnosticOutput.js';
import type {
  ExtractionMetadata,
  ExtractionResource,
  ExtractionResult,
  TextBlockKind,
} from './types.js';

/*
 * Diagnostic view of an extraction for extract:test. It carries metadata, counts and at most a
 * short preview — never the extracted document — because the output may be pasted into tickets.
 */

export const PREVIEW_CHARS = 300;

export function toExtractionResource(
  resource: CourseResource,
  courseName: string,
): ExtractionResource {
  return {
    resourceId: resource.resourceId,
    courseId: resource.courseId,
    courseName,
    sectionId: resource.sectionId,
    sectionName: resource.sectionName,
    moduleId: resource.moduleId,
    moduleName: resource.moduleName,
    resourceName: resource.resourceName,
    fileName: resource.fileName,
    mimeType: resource.mimeType,
    sourceUrl: resource.sourceUrl,
    moduleUrl: resource.moduleUrl,
    timeModified: resource.timeModified,
    role: resource.role,
  };
}

export interface ExtractionStatistics {
  readonly blocks: number;
  readonly characters: number;
  readonly headings: number;
  readonly pages: number;
  readonly slides: number;
  readonly blockKinds: Readonly<Partial<Record<TextBlockKind, number>>>;
}

export interface ExtractionDiagnostic {
  readonly status: ExtractionResult['status'];
  readonly reason?: string;
  readonly resource: ExtractionMetadata;
  readonly extractor?: { readonly name: string; readonly version: string };
  readonly contentHash?: string;
  readonly statistics?: ExtractionStatistics;
  readonly warnings: readonly string[];
  readonly preview?: { readonly characters: number; readonly text: string };
}

function statistics(
  result: Extract<ExtractionResult, { status: 'extracted' }>,
): ExtractionStatistics {
  const blockKinds: Partial<Record<TextBlockKind, number>> = {};
  for (const block of result.blocks) {
    blockKinds[block.kind] = (blockKinds[block.kind] ?? 0) + 1;
  }
  return {
    blocks: result.blocks.length,
    characters: result.characterCount,
    headings: blockKinds.heading ?? 0,
    pages: new Set(result.blocks.map((block) => block.pageNumber).filter((n) => n !== undefined))
      .size,
    slides: new Set(result.blocks.map((block) => block.slideNumber).filter((n) => n !== undefined))
      .size,
    blockKinds,
  };
}

function preview(result: Extract<ExtractionResult, { status: 'extracted' }>): {
  characters: number;
  text: string;
} {
  let text = '';
  for (const block of result.blocks) {
    if (text.length >= PREVIEW_CHARS) {
      break;
    }
    text = text === '' ? block.text : `${text} / ${block.text}`;
  }
  const cut = sanitizeText(text, PREVIEW_CHARS);
  return { characters: cut.length, text: cut };
}

function metadataOf(result: ExtractionResult): ExtractionMetadata {
  return {
    courseId: result.courseId,
    courseName: result.courseName,
    sectionId: result.sectionId,
    sectionName: result.sectionName,
    moduleId: result.moduleId,
    moduleName: result.moduleName,
    resourceId: result.resourceId,
    resourceName: result.resourceName,
    resourceType: result.resourceType,
    fileName: result.fileName,
    mimeType: result.mimeType,
    declaredMimeType: result.declaredMimeType,
    detectedContentType: result.detectedContentType,
    sourceUrl: result.sourceUrl,
    moduleUrl: result.moduleUrl,
    modifiedAt: result.modifiedAt,
    byteLength: result.byteLength,
  };
}

export function toExtractionDiagnostic(
  result: ExtractionResult,
  includePreview: boolean,
): ExtractionDiagnostic {
  const resource = metadataOf(result);
  switch (result.status) {
    case 'extracted':
      return {
        status: 'extracted',
        resource,
        extractor: result.extractor,
        contentHash: result.contentHash,
        statistics: statistics(result),
        warnings: result.warnings,
        ...(includePreview ? { preview: preview(result) } : {}),
      };
    case 'unsupported':
      return { status: 'unsupported', reason: result.reason, resource, warnings: result.warnings };
    case 'failed':
      return {
        status: 'failed',
        reason: result.reason,
        resource,
        ...(result.extractor === undefined ? {} : { extractor: result.extractor }),
        warnings: result.warnings,
      };
  }
}

export function renderExtractionText(diagnostic: ExtractionDiagnostic): string {
  const r = diagnostic.resource;
  const lines = [
    `Extraction: ${diagnostic.status.toUpperCase()}${diagnostic.reason === undefined ? '' : ` (${diagnostic.reason})`}`,
    `  Course:    ${String(r.courseId)} ${sanitizeText(r.courseName)}`,
    `  Section:   ${String(r.sectionId)} ${sanitizeText(r.sectionName)}`,
    `  Module:    ${String(r.moduleId)} ${sanitizeText(r.moduleName)}`,
    `  Resource:  ${sanitizeText(r.resourceId, 200)} ${sanitizeText(r.resourceName)}`,
    `  File:      ${sanitizeText(r.fileName)}  ${formatBytes(r.byteLength)}`,
    `  Type:      detected ${r.detectedContentType}${r.mimeType === undefined ? '' : ` (${r.mimeType})`}; declared ${sanitizeText(r.declaredMimeType, 100)}`,
    `  Modified:  ${r.modifiedAt ?? '-'}`,
    `  Source:    ${sanitizeText(r.sourceUrl, 300)}`,
  ];
  if (diagnostic.extractor !== undefined) {
    lines.push(`  Extractor: ${diagnostic.extractor.name} ${diagnostic.extractor.version}`);
  }
  if (diagnostic.statistics !== undefined) {
    const s = diagnostic.statistics;
    lines.push(
      `  Blocks:    ${String(s.blocks)} (${Object.entries(s.blockKinds)
        .map(([kind, count]) => `${kind}×${String(count)}`)
        .join(', ')})`,
      `  Text:      ${String(s.characters)} characters; ${String(s.headings)} headings; ${String(s.pages)} pages; ${String(s.slides)} slides`,
    );
  }
  if (diagnostic.contentHash !== undefined) {
    lines.push(`  SHA-256:   ${diagnostic.contentHash}`);
  }
  if (diagnostic.warnings.length > 0) {
    lines.push(`  Warnings:  ${diagnostic.warnings.join(', ')}`);
  }
  if (diagnostic.preview !== undefined) {
    lines.push(
      '',
      `Preview (first ${String(diagnostic.preview.characters)} characters):`,
      `  ${diagnostic.preview.text}`,
    );
  }
  return finalizeOutput(lines.join('\n'));
}

/** Result for a resource that discovery already marked unsupported, so nothing was downloaded. */
export function discoveryUnsupportedDiagnostic(
  resource: CourseResource,
  courseName: string,
  reason: string,
): ExtractionDiagnostic {
  return {
    status: 'unsupported',
    reason: `discovery:${reason}`,
    resource: {
      courseId: resource.courseId,
      courseName,
      sectionId: resource.sectionId,
      sectionName: resource.sectionName,
      moduleId: resource.moduleId,
      moduleName: resource.moduleName,
      resourceId: resource.resourceId,
      resourceName: resource.resourceName,
      resourceType: undefined,
      fileName: resource.fileName,
      mimeType: undefined,
      declaredMimeType: resource.mimeType,
      detectedContentType: 'empty',
      sourceUrl: resource.sourceUrl,
      moduleUrl: resource.moduleUrl,
      modifiedAt: resource.timeModified,
      byteLength: 0,
    },
    warnings: ['not_downloaded'],
  };
}
