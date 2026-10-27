import type { ContentItemRole, CourseResource, IsoTimestamp } from '../moodle/models.js';
import type { DetectedContentType } from './contentTypeDetector.js';
import type { Deadline } from './deadline.js';

/** Content types the extractors accept, after independent detection from the bytes. */
export const APPROVED_CONTENT_TYPES = ['pdf', 'docx', 'pptx', 'html', 'plain-text'] as const;
export type ApprovedContentType = (typeof APPROVED_CONTENT_TYPES)[number];

/** What kind of Moodle content was extracted (finer than the detected file type). */
export type ExtractedResourceType =
  'pdf' | 'docx' | 'pptx' | 'html' | 'plain-text' | 'moodle-page' | 'moodle-book-chapter';

export type TextBlockKind =
  'heading' | 'paragraph' | 'list-item' | 'table-row' | 'preformatted' | 'speaker-notes';

export interface TextBlock {
  readonly kind: TextBlockKind;
  /** Normalised text (NFC, collapsed whitespace except in preformatted blocks). */
  readonly text: string;
  /** 1-6 for headings, otherwise undefined. */
  readonly headingLevel: number | undefined;
  /** Titles of the enclosing headings, outermost first (excluding this block). */
  readonly headingPath: readonly string[];
  readonly pageNumber: number | undefined;
  readonly slideNumber: number | undefined;
}

/** The resource being extracted: Phase 3 discovery metadata plus the course name. */
export interface ExtractionResource extends Pick<
  CourseResource,
  | 'resourceId'
  | 'courseId'
  | 'sectionId'
  | 'sectionName'
  | 'moduleId'
  | 'moduleName'
  | 'resourceName'
  | 'fileName'
  | 'mimeType'
  | 'sourceUrl'
  | 'moduleUrl'
  | 'timeModified'
> {
  readonly courseName: string;
  readonly role: ContentItemRole;
}

export interface ExtractionInput {
  readonly bytes: Uint8Array;
  /** Server-declared Content-Type of the download. Untrusted. */
  readonly declaredContentType: string | undefined;
  /** Last-Modified of the download, used when Moodle metadata has no timestamp. */
  readonly lastModified: string | undefined;
}

export interface ExtractionLimits {
  readonly maxInputBytes: number;
  readonly maxTextChars: number;
  readonly timeoutMs: number;
  readonly maxArchiveEntries: number;
  readonly maxUncompressedBytes: number;
  /** Per-entry ceiling inside archives. */
  readonly maxEntryBytes: number;
  /** Uncompressed:compressed ratio above which an entry is treated as a decompression bomb. */
  readonly maxCompressionRatio: number;
  /** Upper bound on XML nesting depth. */
  readonly maxXmlDepth: number;
}

/** A resource as seen by `supports()`: discovery metadata plus the detected content type. */
export interface ExtractionCandidate {
  readonly resource: ExtractionResource;
  readonly contentType: DetectedContentType;
}

export interface ExtractorContext {
  readonly limits: ExtractionLimits;
  readonly deadline: Deadline;
  /** Aborted when the extraction times out; extractors release parser resources on abort. */
  readonly signal: AbortSignal;
}

export interface ExtractorOutput {
  readonly blocks: readonly TextBlock[];
  /** Non-fatal issue codes, e.g. `text_truncated`, `hidden_slides_skipped`. */
  readonly warnings: readonly string[];
}

export interface ContentExtractor {
  readonly name: string;
  /** Bumped whenever output for the same input can change; recorded on every result. */
  readonly version: string;
  readonly resourceType: ExtractedResourceType;
  supports(candidate: ExtractionCandidate): boolean;
  extract(
    candidate: ExtractionCandidate,
    input: ExtractionInput,
    context: ExtractorContext,
  ): Promise<ExtractorOutput>;
}

export type UnsupportedContentReason =
  'unsupported_content_type' | 'macro_enabled_document' | 'legacy_office_format' | 'no_extractor';

export type ExtractionFailureReason =
  | 'encrypted'
  | 'corrupt'
  | 'empty'
  | 'timeout'
  | 'input_too_large'
  | 'archive_limit_exceeded'
  | 'unsafe_archive_entry'
  | 'extractor_error';

export interface ExtractionMetadata {
  readonly courseId: number;
  readonly courseName: string;
  readonly sectionId: number;
  readonly sectionName: string;
  readonly moduleId: number;
  readonly moduleName: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly resourceType: ExtractedResourceType | undefined;
  readonly fileName: string;
  /** MIME type from independent detection; undefined when detection failed. */
  readonly mimeType: string | undefined;
  /** MIME type Moodle or the server declared. */
  readonly declaredMimeType: string | undefined;
  readonly detectedContentType: DetectedContentType;
  readonly sourceUrl: string | undefined;
  readonly moduleUrl: string | undefined;
  readonly modifiedAt: IsoTimestamp | undefined;
  readonly byteLength: number;
}

export interface ExtractorIdentity {
  readonly name: string;
  readonly version: string;
}

export type ExtractionResult =
  | (ExtractionMetadata & {
      readonly status: 'extracted';
      readonly blocks: readonly TextBlock[];
      /** SHA-256 (hex) over the normalised blocks; see textNormalization.ts. */
      readonly contentHash: string;
      readonly characterCount: number;
      readonly warnings: readonly string[];
      readonly extractor: ExtractorIdentity;
    })
  | (ExtractionMetadata & {
      readonly status: 'unsupported';
      readonly reason: UnsupportedContentReason;
      readonly warnings: readonly string[];
    })
  | (ExtractionMetadata & {
      readonly status: 'failed';
      readonly reason: ExtractionFailureReason;
      readonly warnings: readonly string[];
      readonly extractor: ExtractorIdentity | undefined;
    });
