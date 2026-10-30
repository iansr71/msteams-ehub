import { createHash } from 'node:crypto';

import type { ExtractorIdentity } from '../extractors/types.js';
import type { CourseResource, CourseSummary } from '../moodle/models.js';
import type { ChunkingOptions } from '../pipeline/chunkContent.js';
import { CHUNKER_VERSION } from '../pipeline/chunkMetadata.js';
import type { SourceFingerprint } from '../state/syncState.js';

/** The versions of everything that turns a Moodle file into indexed chunks. */
export interface PipelineVersions {
  /** Extractor name → `name@version`. */
  readonly extractors: ReadonlyMap<string, string>;
  /** Changes when any extractor changes; releases quarantined resources for another try. */
  readonly extractorSet: string;
  readonly chunker: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: string;
  readonly embeddingDimensions: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function extractorVersionLabel(identity: ExtractorIdentity): string {
  return `${identity.name}@${identity.version}`;
}

/**
 * Chunk boundaries depend on the settings as well as the algorithm, so both are part of the
 * version: changing CHUNK_TARGET_TOKENS re-chunks every resource.
 */
export function chunkerVersionLabel(options: ChunkingOptions, tokenizer: string): string {
  const settings = sha256(
    JSON.stringify([
      options.targetTokens,
      options.maxTokens,
      options.minTokens,
      options.overlapTokens,
      tokenizer,
    ]),
  ).slice(0, 12);
  return `${CHUNKER_VERSION}#${settings}`;
}

export function buildPipelineVersions(options: {
  readonly extractors: readonly ExtractorIdentity[];
  readonly chunker: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: string;
  readonly embeddingDimensions: number;
}): PipelineVersions {
  const labels = options.extractors.map(extractorVersionLabel);
  return {
    extractors: new Map(
      options.extractors.map((entry) => [entry.name, extractorVersionLabel(entry)]),
    ),
    extractorSet: `set#${sha256(JSON.stringify([...labels].sort())).slice(0, 12)}`,
    chunker: options.chunker,
    embeddingModel: options.embeddingModel,
    embeddingVersion: options.embeddingVersion,
    embeddingDimensions: options.embeddingDimensions,
  };
}

/** The extractor name from a stored `name@version` label. */
export function extractorNameOf(label: string): string {
  const at = label.lastIndexOf('@');
  return at <= 0 ? label : label.slice(0, at);
}

/**
 * Everything copied onto chunks for citations. A renamed course, section or activity, or a
 * changed link, changes the hash and re-indexes the resource even if its file did not change.
 */
export function sourceFingerprint(
  resource: CourseResource,
  course: Pick<CourseSummary, 'fullName' | 'categoryId'>,
): SourceFingerprint {
  const metadataHash = sha256(
    JSON.stringify([
      course.fullName,
      course.categoryId ?? null,
      resource.sectionId,
      resource.sectionName,
      resource.moduleId,
      resource.moduleName,
      resource.resourceName,
      resource.fileName,
      resource.mimeType ?? null,
      resource.moduleUrl ?? null,
      resource.sourceUrl ?? null,
    ]),
  );
  return {
    ...(resource.timeModified === undefined ? {} : { moodleModifiedAt: resource.timeModified }),
    ...(resource.sizeBytes === undefined ? {} : { moodleSizeBytes: resource.sizeBytes }),
    metadataHash,
  };
}
