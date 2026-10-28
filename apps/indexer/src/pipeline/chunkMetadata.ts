import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ExtractedResourceType } from '../extractors/types.js';
import type { NormalizedDocument } from './normalizeContent.js';

/** Bump when the chunking algorithm changes in a way that can change chunk boundaries. */
export const CHUNKER_VERSION = 'structure-aware@1.0.0';

/** Tenant, user and group identifiers: GUIDs or similar opaque IDs, never free text. */
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/);

/**
 * Who may see a chunk. Populated from Moodle enrolments in phase 14. Empty lists mean nobody:
 * retrieval must treat a chunk with no allowed users or groups as inaccessible (fail closed).
 */
export const chunkAccessSchema = z.object({
  allowedUserIds: z.array(identifier).max(50_000),
  allowedGroupIds: z.array(identifier).max(5_000),
});
export type ChunkAccess = z.output<typeof chunkAccessSchema>;

export const contentChunkSchema = z.object({
  /** Deterministic: tenant + course + resource + chunk number (see buildChunkId). */
  chunkId: z.string().regex(/^[0-9a-f]{64}$/),
  tenantId: identifier,
  courseId: z.number().int().positive(),
  courseName: z.string(),
  /** Moodle course category ID as a string (category names need another Moodle function). */
  courseCategory: z.string().optional(),
  sectionId: z.number().int().nonnegative(),
  sectionName: z.string(),
  moduleId: z.number().int().positive(),
  moduleName: z.string(),
  resourceId: z.string().min(1),
  resourceName: z.string(),
  resourceType: z.enum([
    'pdf',
    'docx',
    'pptx',
    'html',
    'plain-text',
    'moodle-page',
    'moodle-book-chapter',
  ]),
  fileName: z.string(),
  mimeType: z.string().optional(),
  /** Most specific heading for the chunk, falling back to the resource name. */
  title: z.string(),
  headingPath: z.array(z.string()),
  /** Chunk text, including any overlap carried from the previous chunk. */
  content: z.string().min(1),
  /** First page covered (PDF). */
  pageNumber: z.number().int().positive().optional(),
  /** Last page covered when the chunk spans pages. */
  pageNumberEnd: z.number().int().positive().optional(),
  slideNumber: z.number().int().positive().optional(),
  /** 1-based position within the resource. */
  chunkNumber: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
  tokenCount: z.number().int().positive(),
  /** Tokens at the start of `content` repeated from the previous chunk. */
  overlapTokens: z.number().int().nonnegative(),
  /** Token-free Moodle file URL. */
  sourceUrl: z.string().optional(),
  /** Moodle activity URL, used for citations. */
  moduleUrl: z.string().optional(),
  /** SHA-256 of this chunk's content. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Extraction content hash of the whole resource (change detection in phase 11). */
  sourceContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  modifiedAt: z.string().optional(),
  indexedAt: z.string(),
  extractorVersion: z.string(),
  chunkerVersion: z.string(),
  allowedUserIds: z.array(identifier),
  allowedGroupIds: z.array(identifier),
  isActive: z.boolean(),
});
export type ContentChunk = z.output<typeof contentChunkSchema>;

export const tenantIdSchema = identifier;

/**
 * Position-based, deterministic ID. Re-chunking a changed resource produces the same IDs for
 * the same positions, so an index update overwrites in place and only surplus chunks need
 * deleting. Hex keeps it valid as an Azure AI Search document key.
 */
export function buildChunkId(
  tenantId: string,
  courseId: number,
  resourceId: string,
  chunkNumber: number,
): string {
  return createHash('sha256')
    .update(
      ['ehub-chunk', tenantId, String(courseId), resourceId, String(chunkNumber)].join('\u0000'),
    )
    .digest('hex');
}

export function hashChunkContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ChunkPlacement {
  readonly content: string;
  readonly tokenCount: number;
  readonly overlapTokens: number;
  readonly headingPath: readonly string[];
  readonly pageNumber: number | undefined;
  readonly pageNumberEnd: number | undefined;
  readonly slideNumber: number | undefined;
}

export interface ChunkContext {
  readonly tenantId: string;
  readonly courseCategory?: string | undefined;
  readonly access: ChunkAccess;
  /** ISO timestamp from an injected clock, so tests are deterministic. */
  readonly indexedAt: string;
}

export function buildContentChunk(
  document: NormalizedDocument,
  placement: ChunkPlacement,
  chunkNumber: number,
  chunkCount: number,
  context: ChunkContext,
): ContentChunk {
  const { metadata } = document;
  if (metadata.resourceType === undefined) {
    throw new Error('Cannot chunk a resource without an extracted resource type.');
  }
  const resourceType: ExtractedResourceType = metadata.resourceType;
  const chunk: ContentChunk = {
    chunkId: buildChunkId(context.tenantId, metadata.courseId, metadata.resourceId, chunkNumber),
    tenantId: context.tenantId,
    courseId: metadata.courseId,
    courseName: metadata.courseName,
    ...(context.courseCategory === undefined ? {} : { courseCategory: context.courseCategory }),
    sectionId: metadata.sectionId,
    sectionName: metadata.sectionName,
    moduleId: metadata.moduleId,
    moduleName: metadata.moduleName,
    resourceId: metadata.resourceId,
    resourceName: metadata.resourceName,
    resourceType,
    fileName: metadata.fileName,
    ...(metadata.mimeType === undefined ? {} : { mimeType: metadata.mimeType }),
    title: placement.headingPath.at(-1) ?? metadata.resourceName,
    headingPath: [...placement.headingPath],
    content: placement.content,
    ...(placement.pageNumber === undefined ? {} : { pageNumber: placement.pageNumber }),
    ...(placement.pageNumberEnd === undefined || placement.pageNumberEnd === placement.pageNumber
      ? {}
      : { pageNumberEnd: placement.pageNumberEnd }),
    ...(placement.slideNumber === undefined ? {} : { slideNumber: placement.slideNumber }),
    chunkNumber,
    chunkCount,
    tokenCount: placement.tokenCount,
    overlapTokens: placement.overlapTokens,
    ...(metadata.sourceUrl === undefined ? {} : { sourceUrl: metadata.sourceUrl }),
    ...(metadata.moduleUrl === undefined ? {} : { moduleUrl: metadata.moduleUrl }),
    contentHash: hashChunkContent(placement.content),
    sourceContentHash: document.sourceContentHash,
    ...(metadata.modifiedAt === undefined ? {} : { modifiedAt: metadata.modifiedAt }),
    indexedAt: context.indexedAt,
    extractorVersion: document.extractorVersion,
    chunkerVersion: CHUNKER_VERSION,
    allowedUserIds: [...context.access.allowedUserIds],
    allowedGroupIds: [...context.access.allowedGroupIds],
    isActive: true,
  };
  // Validates every chunk before it can reach the index.
  return contentChunkSchema.parse(chunk);
}
