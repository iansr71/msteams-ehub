import type {
  FailureCategory,
  IndexedFingerprint,
  ResourceState,
  SourceFingerprint,
  SyncJobType,
} from '../state/syncState.js';

/** What happened to a resource in this job; `transition` turns it into the next state. */
export type ResourceEvent =
  | {
      readonly kind: 'indexed';
      readonly source: SourceFingerprint;
      readonly indexed: IndexedFingerprint;
    }
  /** Downloaded (and possibly extracted) but identical to what is indexed: nothing re-indexed. */
  | {
      readonly kind: 'content_unchanged';
      readonly source: SourceFingerprint;
      readonly fileHash: string;
      readonly contentHash?: string;
    }
  | { readonly kind: 'excluded'; readonly source: SourceFingerprint; readonly reason: string }
  | { readonly kind: 'removed'; readonly reason: string }
  | {
      readonly kind: 'transient_failure';
      readonly source: SourceFingerprint;
      readonly category: FailureCategory;
      /** The source changed or an operator asked: the retry budget starts again. */
      readonly freshAttempt: boolean;
      readonly fileHash?: string;
      readonly contentHash?: string;
    }
  | {
      readonly kind: 'permanent_failure';
      readonly source: SourceFingerprint;
      readonly category: FailureCategory;
      readonly extractorSetVersion: string;
      /** The indexed chunks were removed because they no longer match Moodle. */
      readonly chunksRemoved: boolean;
      readonly fileHash?: string;
      readonly contentHash?: string;
    };

export interface TransitionContext {
  readonly tenantId: string;
  readonly courseId: number;
  readonly resourceId: string;
  readonly moduleId: number;
  readonly jobId: string;
  readonly jobType: SyncJobType;
  readonly now: Date;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

export class InvalidTransitionError extends Error {
  constructor(event: ResourceEvent['kind']) {
    super(`A "${event}" event needs an existing resource state.`);
    this.name = 'InvalidTransitionError';
  }
}

/** Exponential backoff: base, 2×base, 4×base… capped at the maximum. */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The resource state machine. Pure: the next state depends only on the previous state, the
 * event and the context. Chunks in the index are described by `indexed`, which only an
 * `indexed` event sets and only exclusion, removal or a permanent failure that removed the
 * chunks clears; transient failures never touch it, so an old version stays searchable.
 */
export function transition(
  previous: ResourceState | undefined,
  event: ResourceEvent,
  context: TransitionContext,
): ResourceState {
  const now = context.now.toISOString();
  const base = {
    tenantId: context.tenantId,
    courseId: context.courseId,
    resourceId: context.resourceId,
    moduleId: context.moduleId,
    lastJobId: context.jobId,
    lastJobType: context.jobType,
    updatedAt: now,
    ...(previous?.lastSuccessfulIndexAt === undefined
      ? {}
      : { lastSuccessfulIndexAt: previous.lastSuccessfulIndexAt }),
  };

  switch (event.kind) {
    case 'indexed':
      return {
        ...base,
        status: 'indexed',
        observed: event.source,
        lastFileHash: event.indexed.fileHash,
        lastContentHash: event.indexed.contentHash,
        indexed: event.indexed,
        retryCount: 0,
        lastAttemptAt: now,
        lastSuccessfulIndexAt: event.indexed.indexedAt,
      };

    case 'content_unchanged': {
      const indexed = previous?.indexed;
      if (previous === undefined || indexed === undefined) {
        throw new InvalidTransitionError(event.kind);
      }
      const updated: Mutable<IndexedFingerprint> = { ...indexed, fileHash: event.fileHash };
      delete updated.moodleModifiedAt;
      delete updated.moodleSizeBytes;
      return {
        ...base,
        status: 'indexed',
        observed: event.source,
        lastFileHash: event.fileHash,
        ...(event.contentHash === undefined ? {} : { lastContentHash: event.contentHash }),
        indexed: { ...updated, ...event.source },
        retryCount: 0,
        lastAttemptAt: now,
      };
    }

    case 'excluded':
      return {
        ...base,
        status: 'excluded',
        statusReason: event.reason,
        observed: event.source,
        retryCount: 0,
      };

    case 'removed':
      if (previous === undefined) {
        throw new InvalidTransitionError(event.kind);
      }
      return {
        ...base,
        status: 'removed',
        statusReason: event.reason,
        observed: previous.observed,
        retryCount: 0,
      };

    case 'transient_failure': {
      const retryCount = (event.freshAttempt ? 0 : (previous?.retryCount ?? 0)) + 1;
      const deadLetter = retryCount >= context.maxAttempts;
      const state: Mutable<ResourceState> = {
        ...base,
        status: deadLetter ? 'dead_letter' : 'failed',
        observed: event.source,
        retryCount,
        failureCategory: event.category,
        lastAttemptAt: now,
      };
      if (!deadLetter) {
        state.nextRetryAt = new Date(
          context.now.getTime() +
            retryDelayMs(retryCount, context.retryBaseDelayMs, context.retryMaxDelayMs),
        ).toISOString();
      }
      copyHashes(state, previous, event);
      if (previous?.indexed !== undefined) {
        state.indexed = previous.indexed;
      }
      return state;
    }

    case 'permanent_failure': {
      const state: Mutable<ResourceState> = {
        ...base,
        status: 'quarantined',
        observed: event.source,
        retryCount: 0,
        failureCategory: event.category,
        extractorSetVersion: event.extractorSetVersion,
        lastAttemptAt: now,
      };
      copyHashes(state, previous, event);
      if (!event.chunksRemoved && previous?.indexed !== undefined) {
        state.indexed = previous.indexed;
      }
      return state;
    }
  }
}

function copyHashes(
  state: Mutable<ResourceState>,
  previous: ResourceState | undefined,
  event: { readonly fileHash?: string; readonly contentHash?: string },
): void {
  const fileHash = event.fileHash ?? previous?.lastFileHash;
  const contentHash = event.contentHash ?? previous?.lastContentHash;
  if (fileHash !== undefined) {
    state.lastFileHash = fileHash;
  }
  if (contentHash !== undefined) {
    state.lastContentHash = contentHash;
  }
}
