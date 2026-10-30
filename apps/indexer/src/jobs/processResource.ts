import { toExtractionResource } from '../extractors/extractionDiagnostics.js';
import type { CourseResource, CourseStructure } from '../moodle/models.js';
import { normalizeContent } from '../pipeline/normalizeContent.js';
import { embedChunks } from '../search/chunkEmbedder.js';
import type { ResourceState, SourceFingerprint } from '../state/syncState.js';
import { startsFreshAttempt, unchangedAfterHash, type ChangeReason } from './changeDetection.js';
import {
  UNSUPPORTED_CONTENT_FAILURE,
  classifyError,
  classifyExtractionFailure,
  type FailureClassification,
} from './failureClassification.js';
import { extractorVersionLabel, hashBytes } from './fingerprints.js';
import { replaceResourceChunks } from './indexReplacement.js';
import { removeResourceChunks } from './indexReplacement.js';
import { SyncJobAbortedError, type SyncJob } from './syncContext.js';
import type { ResourceEvent } from './stateTransitions.js';

export interface ProcessOutcome {
  readonly event: ResourceEvent;
  readonly chunks?: number;
  readonly staleChunksRemoved?: number;
  readonly chunksRemoved?: number;
  readonly embeddings?: { readonly generated: number; readonly cached: number };
}

interface Progress {
  fileHash?: string;
  contentHash?: string;
}

/**
 * The pipeline for one changed resource: download → extract → normalise → chunk → embed →
 * replace chunks. Returns the event for the state machine; throws SyncJobAbortedError for
 * failures that affect the whole job.
 */
export async function processResource(
  job: SyncJob,
  structure: CourseStructure,
  resource: CourseResource,
  reasons: readonly ChangeReason[],
  state: ResourceState | undefined,
  source: SourceFingerprint,
): Promise<ProcessOutcome> {
  const { services } = job;
  const { settings } = services;
  const progress: Progress = {};
  const scope = {
    tenantId: settings.tenantId,
    courseId: resource.courseId,
    resourceId: resource.resourceId,
  };

  const fail = async (classification: FailureClassification): Promise<ProcessOutcome> => {
    if (classification.scope === 'job') {
      throw new SyncJobAbortedError(classification.category);
    }
    const hashes = {
      ...(progress.fileHash === undefined ? {} : { fileHash: progress.fileHash }),
      ...(progress.contentHash === undefined ? {} : { contentHash: progress.contentHash }),
    };
    if (classification.scope === 'transient') {
      return {
        event: {
          kind: 'transient_failure',
          source,
          category: classification.category,
          freshAttempt: startsFreshAttempt(reasons),
          ...hashes,
        },
      };
    }
    // A permanent failure on a new version of the file: the indexed chunks describe a file
    // Moodle no longer serves, so they are removed rather than left answering questions.
    const indexed = state?.indexed;
    const sourceChanged =
      progress.fileHash === undefined
        ? reasons.includes('moodle_modified')
        : indexed !== undefined && progress.fileHash !== indexed.fileHash;
    let chunksRemoved = 0;
    if (indexed !== undefined && sourceChanged) {
      try {
        chunksRemoved = await removeResourceChunks(services.search, scope, job.signal);
      } catch (error) {
        const removal = classifyError(error);
        if (removal.scope === 'job') {
          throw new SyncJobAbortedError(removal.category);
        }
        return {
          event: {
            kind: 'transient_failure',
            source,
            category: removal.category,
            freshAttempt: startsFreshAttempt(reasons),
            ...hashes,
          },
        };
      }
    }
    return {
      event: {
        kind: 'permanent_failure',
        source,
        category: classification.category,
        extractorSetVersion: services.versions.extractorSet,
        chunksRemoved: indexed !== undefined && sourceChanged,
        ...hashes,
      },
      ...(chunksRemoved > 0 ? { chunksRemoved } : {}),
    };
  };

  try {
    const sourceUrl = resource.sourceUrl;
    if (sourceUrl === undefined) {
      // decideResource excludes these; reaching here is a programming error.
      return await fail(UNSUPPORTED_CONTENT_FAILURE);
    }
    const file = await services.moodle.downloader.download(sourceUrl, {
      maxBytes: settings.maxDownloadBytes,
      ...(job.signal === undefined ? {} : { signal: job.signal }),
    });
    progress.fileHash = hashBytes(file.bytes);
    if (unchangedAfterHash(reasons, state, { fileHash: progress.fileHash })) {
      return { event: { kind: 'content_unchanged', source, fileHash: progress.fileHash } };
    }

    const extraction = await services.extractors.extract(
      toExtractionResource(resource, structure.course.fullName),
      {
        bytes: file.bytes,
        declaredContentType: file.contentType,
        lastModified: file.lastModified,
      },
    );
    if (extraction.status === 'unsupported') {
      return await fail(UNSUPPORTED_CONTENT_FAILURE);
    }
    if (extraction.status === 'failed') {
      return await fail(classifyExtractionFailure(extraction.reason));
    }
    progress.contentHash = extraction.contentHash;
    if (
      unchangedAfterHash(reasons, state, {
        fileHash: progress.fileHash,
        contentHash: extraction.contentHash,
      })
    ) {
      return {
        event: {
          kind: 'content_unchanged',
          source,
          fileHash: progress.fileHash,
          contentHash: extraction.contentHash,
        },
      };
    }

    const document = normalizeContent(extraction);
    const categoryId = structure.course.categoryId;
    const indexedAt = services.clock.now().toISOString();
    const chunks = services.chunker.chunk(document, {
      tenantId: settings.tenantId,
      courseCategory: categoryId === undefined ? undefined : String(categoryId),
      // Access is enforced per authorised course at query time (docs/retrieval.md).
      access: { allowedUserIds: [], allowedGroupIds: [] },
      indexedAt,
    });
    if (chunks.length === 0) {
      return await fail({ scope: 'permanent', category: 'no_indexable_text' });
    }

    const embedded = await embedChunks(
      chunks,
      services.embedder,
      services.versions.embeddingDimensions,
      job.signal === undefined ? {} : { signal: job.signal },
    );
    const replacement = await replaceResourceChunks(
      services.search,
      scope,
      embedded.documents,
      job.signal,
    );
    const { versions } = services;
    return {
      event: {
        kind: 'indexed',
        source,
        indexed: {
          ...source,
          fileHash: progress.fileHash,
          contentHash: extraction.contentHash,
          extractorVersion: extractorVersionLabel(extraction.extractor),
          chunkerVersion: versions.chunker,
          embeddingModel: versions.embeddingModel,
          embeddingVersion: versions.embeddingVersion,
          embeddingDimensions: versions.embeddingDimensions,
          chunkCount: chunks.length,
          indexedAt,
        },
      },
      chunks: chunks.length,
      staleChunksRemoved: replacement.staleRemoved,
      embeddings: { generated: embedded.generated, cached: embedded.cached },
    };
  } catch (error) {
    if (error instanceof SyncJobAbortedError) {
      throw error;
    }
    return await fail(classifyError(error));
  }
}
