import type { ExtractionConfig, Logger } from '@ehub/shared';

import { detectContentType, MIME_TYPES, type DetectedContentType } from './contentTypeDetector.js';
import { Deadline, runWithDeadline, type Clock } from './deadline.js';
import { docxExtractor } from './docxExtractor.js';
import { isExtractionFailure } from './errors.js';
import { htmlExtractor } from './htmlExtractor.js';
import { moodleBookExtractor } from './moodleBookExtractor.js';
import { moodlePageExtractor } from './moodlePageExtractor.js';
import { pdfExtractor } from './pdfExtractor.js';
import { plainTextExtractor } from './plainTextExtractor.js';
import { pptxExtractor } from './pptxExtractor.js';
import { computeContentHash } from './textNormalization.js';
import {
  APPROVED_CONTENT_TYPES,
  type ApprovedContentType,
  type ContentExtractor,
  type ExtractionFailureReason,
  type ExtractionInput,
  type ExtractionLimits,
  type ExtractionMetadata,
  type ExtractionResource,
  type ExtractionResult,
  type ExtractorIdentity,
  type UnsupportedContentReason,
} from './types.js';

export const DEFAULT_EXTRACTORS: readonly ContentExtractor[] = [
  moodlePageExtractor,
  moodleBookExtractor,
  pdfExtractor,
  docxExtractor,
  pptxExtractor,
  htmlExtractor,
  plainTextExtractor,
];

const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_XML_DEPTH = 256;

export function extractionLimitsFromConfig(config: ExtractionConfig): ExtractionLimits {
  return {
    maxInputBytes: config.EXTRACTION_MAX_INPUT_BYTES,
    maxTextChars: config.EXTRACTION_MAX_TEXT_CHARS,
    timeoutMs: config.EXTRACTION_TIMEOUT_MS,
    maxArchiveEntries: config.EXTRACTION_MAX_ARCHIVE_ENTRIES,
    maxUncompressedBytes: config.EXTRACTION_MAX_UNCOMPRESSED_BYTES,
    maxEntryBytes: Math.min(MAX_ENTRY_BYTES, config.EXTRACTION_MAX_UNCOMPRESSED_BYTES),
    maxCompressionRatio: MAX_COMPRESSION_RATIO,
    maxXmlDepth: MAX_XML_DEPTH,
  };
}

const UNSUPPORTED_TYPES: Readonly<Partial<Record<DetectedContentType, UnsupportedContentReason>>> =
  {
    'ooxml-macro': 'macro_enabled_document',
    'ole-legacy': 'legacy_office_format',
    'zip-other': 'unsupported_content_type',
    binary: 'unsupported_content_type',
  };

function isApproved(type: DetectedContentType): type is ApprovedContentType {
  return (APPROVED_CONTENT_TYPES as readonly string[]).includes(type);
}

function toIso(httpDate: string | undefined): string | undefined {
  if (httpDate === undefined) {
    return undefined;
  }
  const parsed = Date.parse(httpDate);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Declared type (Moodle metadata or HTTP header) that names a different approved type. */
function declaredMismatch(declared: string | undefined, detected: ApprovedContentType): boolean {
  const base = declared?.split(';')[0]?.trim().toLowerCase();
  if (base === undefined || base === '' || base === 'application/octet-stream') {
    return false;
  }
  const declaredType = (Object.entries(MIME_TYPES) as [ApprovedContentType, string][]).find(
    ([, mime]) => mime === base,
  )?.[0];
  return declaredType !== undefined && declaredType !== detected;
}

export interface ExtractorRegistryOptions {
  readonly limits: ExtractionLimits;
  readonly extractors?: readonly ContentExtractor[];
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/**
 * Runs the right extractor for a resource and always returns a structured result: extraction
 * problems never throw out of `extract`, so one bad document cannot stop an indexing job.
 */
export class ExtractorRegistry {
  readonly #limits: ExtractionLimits;
  readonly #extractors: readonly ContentExtractor[];
  readonly #logger: Logger | undefined;
  readonly #clock: Clock | undefined;

  constructor(options: ExtractorRegistryOptions) {
    this.#limits = options.limits;
    this.#extractors = options.extractors ?? DEFAULT_EXTRACTORS;
    this.#logger = options.logger?.child({ component: 'extractor-registry' });
    this.#clock = options.clock;
  }

  async extract(resource: ExtractionResource, input: ExtractionInput): Promise<ExtractionResult> {
    let detected: DetectedContentType = 'empty';
    let extractor: ContentExtractor | undefined;
    const warnings: string[] = [];

    const metadata = (): ExtractionMetadata => ({
      courseId: resource.courseId,
      courseName: resource.courseName,
      sectionId: resource.sectionId,
      sectionName: resource.sectionName,
      moduleId: resource.moduleId,
      moduleName: resource.moduleName,
      resourceId: resource.resourceId,
      resourceName: resource.resourceName,
      resourceType: extractor?.resourceType,
      fileName: resource.fileName,
      mimeType: isApproved(detected) ? MIME_TYPES[detected] : undefined,
      declaredMimeType: resource.mimeType ?? input.declaredContentType,
      detectedContentType: detected,
      sourceUrl: resource.sourceUrl,
      moduleUrl: resource.moduleUrl,
      modifiedAt: resource.timeModified ?? toIso(input.lastModified),
      byteLength: input.bytes.byteLength,
    });
    const identity = (): ExtractorIdentity | undefined =>
      extractor === undefined ? undefined : { name: extractor.name, version: extractor.version };
    const failed = (reason: ExtractionFailureReason): ExtractionResult => {
      this.#logger?.warn('Extraction failed.', {
        resourceId: resource.resourceId,
        reason,
        detectedContentType: detected,
        extractor: extractor?.name,
      });
      return { ...metadata(), status: 'failed', reason, warnings, extractor: identity() };
    };
    const unsupported = (reason: UnsupportedContentReason): ExtractionResult => {
      this.#logger?.info('Content not supported for extraction.', {
        resourceId: resource.resourceId,
        reason,
        detectedContentType: detected,
      });
      return { ...metadata(), status: 'unsupported', reason, warnings };
    };

    if (input.bytes.byteLength > this.#limits.maxInputBytes) {
      return failed('input_too_large');
    }

    const deadline = new Deadline(this.#limits.timeoutMs, this.#clock);
    const controller = new AbortController();
    try {
      detected = await runWithDeadline(
        detectContentType(input.bytes, this.#limits, deadline),
        deadline,
        controller,
      );
      if (detected === 'empty') {
        return failed('empty');
      }
      if (detected === 'ole-encrypted') {
        return failed('encrypted');
      }
      const unsupportedReason = UNSUPPORTED_TYPES[detected];
      if (unsupportedReason !== undefined || !isApproved(detected)) {
        return unsupported(unsupportedReason ?? 'unsupported_content_type');
      }
      if (declaredMismatch(resource.mimeType ?? input.declaredContentType, detected)) {
        warnings.push('declared_type_mismatch');
      }

      const candidate = { resource, contentType: detected };
      extractor = this.#extractors.find((entry) => entry.supports(candidate));
      if (extractor === undefined) {
        return unsupported('no_extractor');
      }

      const output = await runWithDeadline(
        extractor.extract(candidate, input, {
          limits: this.#limits,
          deadline,
          signal: controller.signal,
        }),
        deadline,
        controller,
      );
      warnings.push(...output.warnings);
      if (output.blocks.length === 0) {
        return failed('empty');
      }

      const result: ExtractionResult = {
        ...metadata(),
        status: 'extracted',
        blocks: output.blocks,
        contentHash: computeContentHash(output.blocks),
        characterCount: output.blocks.reduce((sum, block) => sum + block.text.length, 0),
        warnings,
        extractor: { name: extractor.name, version: extractor.version },
      };
      this.#logger?.debug('Extraction completed.', {
        resourceId: resource.resourceId,
        extractor: extractor.name,
        blocks: result.blocks.length,
        characters: result.characterCount,
        warnings,
      });
      return result;
    } catch (error) {
      // Only the reason code is kept: parser messages can quote document content.
      return failed(isExtractionFailure(error) ? error.reason : 'extractor_error');
    } finally {
      controller.abort();
    }
  }
}
