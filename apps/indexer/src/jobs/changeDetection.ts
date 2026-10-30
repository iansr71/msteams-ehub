import type { CourseResource } from '../moodle/models.js';
import type { ResourceState, SourceFingerprint } from '../state/syncState.js';
import { extractorNameOf, type PipelineVersions } from './fingerprints.js';

/** Why a resource is (re)processed. Several can apply at once. */
export type ChangeReason =
  | 'new'
  | 'moodle_modified'
  /** Moodle reports no modification time, so the file is downloaded and hashed to compare. */
  | 'modified_unknown'
  | 'metadata_changed'
  | 'extractor_changed'
  | 'chunker_changed'
  | 'embedding_changed'
  /** Full sync: download and hash even though Moodle reports no change. */
  | 'verify'
  | 'retry'
  /** An operator asked to retry a dead-lettered resource. */
  | 'operator_retry'
  | 'forced';

/** Reasons that only say the source *may* have changed; matching hashes mean it did not. */
const SOURCE_ONLY_REASONS: ReadonlySet<ChangeReason> = new Set([
  'moodle_modified',
  'modified_unknown',
  'verify',
]);

export type SkipReason =
  | 'unchanged'
  | 'content_unchanged'
  | 'quarantined'
  | 'dead_letter'
  | 'retry_not_due'
  | 'already_excluded'
  | 'already_removed';

export type ResourceDecision =
  | { readonly kind: 'process'; readonly reasons: readonly ChangeReason[] }
  | { readonly kind: 'skip'; readonly reason: SkipReason }
  /** Not indexed by policy; any chunks it has are removed. */
  | { readonly kind: 'exclude'; readonly reason: string };

/**
 * - `incremental`: compare Moodle metadata and versions; download only what changed.
 * - `full`: as incremental, and also download and hash every indexed resource (`verify`), for
 *   changes Moodle's timestamps miss.
 * - `retry`: retry failed resources now, ignoring the backoff; dead-lettered ones only with
 *   `includeDeadLetter`.
 * - `single`: one resource on request; failed resources ignore the backoff.
 */
export type DecisionMode = 'incremental' | 'full' | 'retry' | 'single';

export interface DecisionInput {
  readonly resource: CourseResource;
  readonly courseHidden: boolean;
  readonly source: SourceFingerprint;
  readonly state: ResourceState | undefined;
  readonly versions: PipelineVersions;
  readonly mode: DecisionMode;
  readonly force: boolean;
  readonly includeHidden: boolean;
  readonly includeDeadLetter: boolean;
  readonly now: Date;
}

export function exclusionReason(
  resource: CourseResource,
  courseHidden: boolean,
  includeHidden: boolean,
): string | undefined {
  if (!includeHidden && (courseHidden || resource.hiddenFromStudents)) {
    return 'hidden';
  }
  if (resource.support.status === 'unsupported') {
    return `unsupported:${resource.support.reason}`;
  }
  if (resource.sourceUrl === undefined) {
    return 'unsupported:missing_file_url';
  }
  return undefined;
}

function sourceChanged(previous: SourceFingerprint, current: SourceFingerprint): boolean {
  return (
    previous.moodleModifiedAt !== current.moodleModifiedAt ||
    previous.moodleSizeBytes !== current.moodleSizeBytes ||
    previous.metadataHash !== current.metadataHash
  );
}

/** Differences between what is indexed and what the current pipeline would produce. */
function indexedChanges(
  state: ResourceState,
  source: SourceFingerprint,
  versions: PipelineVersions,
): ChangeReason[] {
  const indexed = state.indexed;
  if (indexed === undefined) {
    return ['new'];
  }
  const reasons: ChangeReason[] = [];
  if (source.moodleModifiedAt === undefined) {
    reasons.push('modified_unknown');
  } else if (
    indexed.moodleModifiedAt !== source.moodleModifiedAt ||
    indexed.moodleSizeBytes !== source.moodleSizeBytes
  ) {
    reasons.push('moodle_modified');
  }
  if (indexed.metadataHash !== source.metadataHash) {
    reasons.push('metadata_changed');
  }
  if (
    versions.extractors.get(extractorNameOf(indexed.extractorVersion)) !== indexed.extractorVersion
  ) {
    reasons.push('extractor_changed');
  }
  if (indexed.chunkerVersion !== versions.chunker) {
    reasons.push('chunker_changed');
  }
  if (
    indexed.embeddingModel !== versions.embeddingModel ||
    indexed.embeddingVersion !== versions.embeddingVersion ||
    indexed.embeddingDimensions !== versions.embeddingDimensions
  ) {
    reasons.push('embedding_changed');
  }
  return reasons;
}

/** The primary reason plus anything else that differs from the indexed chunks. */
function process(
  primary: ChangeReason,
  state: ResourceState,
  source: SourceFingerprint,
  versions: PipelineVersions,
): ResourceDecision {
  const others = state.indexed === undefined ? [] : indexedChanges(state, source, versions);
  return { kind: 'process', reasons: [primary, ...others.filter((reason) => reason !== primary)] };
}

/** Decides what to do with one resource that Moodle currently lists. Pure. */
export function decideResource(input: DecisionInput): ResourceDecision {
  const { state, source, versions, mode } = input;

  const excluded = exclusionReason(input.resource, input.courseHidden, input.includeHidden);
  if (excluded !== undefined) {
    return state?.status === 'excluded' &&
      state.statusReason === excluded &&
      state.indexed === undefined
      ? { kind: 'skip', reason: 'already_excluded' }
      : { kind: 'exclude', reason: excluded };
  }
  if (input.force) {
    return { kind: 'process', reasons: ['forced'] };
  }
  if (state === undefined || state.status === 'removed' || state.status === 'excluded') {
    return { kind: 'process', reasons: ['new'] };
  }

  switch (state.status) {
    case 'quarantined':
      // Permanent failures are retried only when the input or an extractor changes.
      if (sourceChanged(state.observed, source)) {
        return process('moodle_modified', state, source, versions);
      }
      return state.extractorSetVersion !== versions.extractorSet
        ? process('extractor_changed', state, source, versions)
        : { kind: 'skip', reason: 'quarantined' };
    case 'dead_letter':
      if (sourceChanged(state.observed, source)) {
        return process('moodle_modified', state, source, versions);
      }
      return mode === 'retry' && input.includeDeadLetter
        ? process('operator_retry', state, source, versions)
        : { kind: 'skip', reason: 'dead_letter' };
    case 'failed': {
      if (sourceChanged(state.observed, source)) {
        return process('moodle_modified', state, source, versions);
      }
      const due =
        state.nextRetryAt === undefined || Date.parse(state.nextRetryAt) <= input.now.getTime();
      return due || mode === 'retry' || mode === 'single'
        ? process('retry', state, source, versions)
        : { kind: 'skip', reason: 'retry_not_due' };
    }
    case 'indexed': {
      const reasons = indexedChanges(state, source, versions);
      if (mode === 'full' && reasons.length === 0) {
        reasons.push('verify');
      }
      return reasons.length === 0
        ? { kind: 'skip', reason: 'unchanged' }
        : { kind: 'process', reasons };
    }
  }
}

/**
 * After download (and extraction), whether the resource can be left as it is: every reason was
 * a "source may have changed" signal and the hash shows it did not.
 */
export function unchangedAfterHash(
  reasons: readonly ChangeReason[],
  state: ResourceState | undefined,
  hashes: { readonly fileHash: string; readonly contentHash?: string },
): boolean {
  const indexed = state?.indexed;
  if (indexed === undefined || !reasons.every((reason) => SOURCE_ONLY_REASONS.has(reason))) {
    return false;
  }
  return (
    indexed.fileHash === hashes.fileHash ||
    (hashes.contentHash !== undefined && indexed.contentHash === hashes.contentHash)
  );
}

/** Whether a new attempt starts a fresh retry budget (the source changed or an operator asked). */
export function startsFreshAttempt(reasons: readonly ChangeReason[]): boolean {
  return reasons.some(
    (reason) =>
      reason === 'new' ||
      reason === 'moodle_modified' ||
      reason === 'metadata_changed' ||
      reason === 'operator_retry' ||
      reason === 'forced',
  );
}
