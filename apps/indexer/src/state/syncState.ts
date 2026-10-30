import { z } from 'zod';

/*
 * Synchronisation state, independent of any database. The same records are stored by the
 * local file repository and by production stores (Azure SQL, PostgreSQL, Azure Table Storage);
 * see docs/sync.md for the table layouts.
 */

export const SYNC_JOB_TYPES = [
  'full',
  'incremental',
  'course',
  'resource',
  'retry-failed',
  'reconcile',
] as const;
export type SyncJobType = (typeof SYNC_JOB_TYPES)[number];

/**
 * - `indexed`: the resource's chunks are in the index and match `indexed`.
 * - `failed`: a transient failure; retried with backoff until SYNC_MAX_ATTEMPTS.
 * - `dead_letter`: transient failures exhausted the attempts; retried only when Moodle changes
 *   the resource or an operator asks (`sync:retry-failed --include-dead-letter`).
 * - `quarantined`: a permanent failure (e.g. encrypted, corrupt, unsupported); retried only
 *   when Moodle changes the resource or an extractor changes.
 * - `excluded`: deliberately not indexed (hidden, or unsupported by discovery).
 * - `removed`: deleted from Moodle or no longer selected; its chunks were removed.
 */
export const RESOURCE_STATUSES = [
  'indexed',
  'failed',
  'dead_letter',
  'quarantined',
  'excluded',
  'removed',
] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

/** Sanitised, fixed vocabulary: never error messages or document text. */
export const FAILURE_CATEGORIES = [
  // Transient (retried, bounded).
  'moodle_unavailable',
  'moodle_throttled',
  'moodle_file_forbidden',
  'moodle_file_not_found',
  'moodle_error',
  'extraction_timeout',
  'extractor_error',
  'embedding_unavailable',
  'embedding_rejected_response',
  'index_unavailable',
  'index_rejected',
  'index_partial_failure',
  'state_conflict',
  'unexpected_error',
  // Permanent (quarantined).
  'file_too_large',
  'unsafe_download',
  'unsupported_content',
  'encrypted',
  'corrupt',
  'empty',
  'archive_limit_exceeded',
  'unsafe_archive_entry',
  'no_indexable_text',
  'invalid_chunk',
  'embedding_input_rejected',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestamp = z.iso.datetime({ offset: true });
const shortText = z.string().min(1).max(200);

/** What Moodle reported for the resource, compared on the next run. */
export const sourceFingerprintSchema = z.object({
  /** Moodle `timemodified`; undefined when Moodle does not report one. */
  moodleModifiedAt: isoTimestamp.optional(),
  moodleSizeBytes: z.number().int().nonnegative().optional(),
  /** Hash of the citation metadata (names, URLs, section); a rename re-indexes. */
  metadataHash: sha256Hex,
});
export type SourceFingerprint = z.output<typeof sourceFingerprintSchema>;

/** How the chunks currently in the index were produced. */
export const indexedFingerprintSchema = sourceFingerprintSchema.extend({
  /** SHA-256 of the downloaded bytes. */
  fileHash: sha256Hex,
  /** Extraction content hash (normalised text); equals `sourceContentHash` on the chunks. */
  contentHash: sha256Hex,
  /** `name@version` of the extractor. */
  extractorVersion: shortText,
  /** Chunker version plus a hash of the chunking settings. */
  chunkerVersion: shortText,
  embeddingModel: shortText,
  embeddingVersion: shortText,
  embeddingDimensions: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
  indexedAt: isoTimestamp,
});
export type IndexedFingerprint = z.output<typeof indexedFingerprintSchema>;

export const resourceStateSchema = z.object({
  tenantId: z.string().min(1).max(128),
  courseId: z.number().int().positive(),
  resourceId: z.string().min(1).max(1100),
  moduleId: z.number().int().positive(),
  status: z.enum(RESOURCE_STATUSES),
  /** Why the resource is excluded or removed (`hidden`, `deleted`, `course_not_selected`…). */
  statusReason: shortText.optional(),
  /** The source as last observed (on the last attempt or check). */
  observed: sourceFingerprintSchema,
  /** Hashes from the last attempt that got that far, indexed or not. */
  lastFileHash: sha256Hex.optional(),
  lastContentHash: sha256Hex.optional(),
  /** The extractor set version on the last permanent failure (quarantine release). */
  extractorSetVersion: shortText.optional(),
  /** Set while the resource has chunks in the index. */
  indexed: indexedFingerprintSchema.optional(),
  /** Failed attempts since the last success or source change. */
  retryCount: z.number().int().nonnegative(),
  failureCategory: z.enum(FAILURE_CATEGORIES).optional(),
  nextRetryAt: isoTimestamp.optional(),
  lastJobId: shortText,
  lastJobType: z.enum(SYNC_JOB_TYPES),
  lastAttemptAt: isoTimestamp.optional(),
  lastSuccessfulIndexAt: isoTimestamp.optional(),
  updatedAt: isoTimestamp,
});
export type ResourceState = z.output<typeof resourceStateSchema>;

/** A stored record carries a revision for optimistic concurrency (ETag / rowversion). */
export const storedResourceStateSchema = resourceStateSchema.extend({
  revision: z.number().int().positive(),
});
export type StoredResourceState = z.output<typeof storedResourceStateSchema>;

export interface ResourceKey {
  readonly tenantId: string;
  readonly courseId: number;
  readonly resourceId: string;
}

export function resourceKeyOf(state: ResourceKey): ResourceKey {
  return { tenantId: state.tenantId, courseId: state.courseId, resourceId: state.resourceId };
}

export const SYNC_JOB_STATUSES = [
  'running',
  'succeeded',
  'completed_with_failures',
  'failed',
] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number];

export const syncCountsSchema = z.object({
  processed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type SyncCounts = z.output<typeof syncCountsSchema>;

export const syncJobRecordSchema = z.object({
  jobId: shortText,
  jobType: z.enum(SYNC_JOB_TYPES),
  tenantId: z.string().min(1).max(128),
  status: z.enum(SYNC_JOB_STATUSES),
  dryRun: z.boolean(),
  correlationId: shortText.optional(),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
  courseIds: z.array(z.number().int().positive()).max(10_000),
  counts: syncCountsSchema,
  /** Job-level failure category, when the job stopped early. */
  failureCategory: shortText.optional(),
});
export type SyncJobRecord = z.output<typeof syncJobRecordSchema>;

export const leaseSchema = z.object({
  name: z.string().min(1).max(300),
  owner: shortText,
  /** Random per acquisition, so a renewal or release by a stale holder is detected. */
  token: shortText,
  expiresAt: isoTimestamp,
});
export type Lease = z.output<typeof leaseSchema>;

export function courseLeaseName(tenantId: string, courseId: number): string {
  return `course:${tenantId}:${String(courseId)}`;
}
