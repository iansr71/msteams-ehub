import type {
  Lease,
  ResourceKey,
  ResourceState,
  ResourceStatus,
  StoredResourceState,
  SyncJobRecord,
} from './syncState.js';

export interface ResourceStateQuery {
  readonly tenantId: string;
  readonly courseId?: number;
  readonly statuses?: readonly ResourceStatus[];
}

export interface LeaseRequest {
  readonly name: string;
  readonly owner: string;
  readonly ttlMs: number;
}

/**
 * Persistence for synchronisation state. Domain logic depends only on this interface.
 *
 * Contract (checked by `syncStateRepositoryContract`, which every implementation must pass):
 * - `saveResource` is a conditional write. `expectedRevision` null means "create; fail if the
 *   record exists"; a number means "replace only if the stored revision is still this". A
 *   mismatch throws `SyncStateConflictError`. This maps to `INSERT` / `UPDATE … WHERE
 *   revision = @expected` (SQL), and to `If-Match: <ETag>` / insert-only (Azure Tables).
 * - `acquireLease` succeeds when the lease is absent, expired, or already held by the same
 *   owner, and returns undefined while another owner holds an unexpired lease. Renew and
 *   release require the token of the current acquisition.
 * - Records returned are validated copies: mutating them does not change stored state.
 */
export interface SyncStateRepository {
  getResource(key: ResourceKey): Promise<StoredResourceState | undefined>;
  listResources(query: ResourceStateQuery): Promise<StoredResourceState[]>;
  /** Distinct course IDs that have resource state in the tenant. */
  listCourseIds(tenantId: string): Promise<number[]>;
  saveResource(state: ResourceState, expectedRevision: number | null): Promise<StoredResourceState>;

  acquireLease(request: LeaseRequest): Promise<Lease | undefined>;
  /** Extends a lease still held with the same token; undefined when it was lost. */
  renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined>;
  releaseLease(lease: Lease): Promise<void>;

  saveJob(job: SyncJobRecord): Promise<void>;
  getJob(jobId: string): Promise<SyncJobRecord | undefined>;
  /** Most recent first. */
  listJobs(limit: number): Promise<SyncJobRecord[]>;
}

export class SyncStateConflictError extends Error {
  readonly code = 'state_conflict';

  constructor() {
    super('The sync state record was changed by another process.');
    this.name = 'SyncStateConflictError';
  }
}

export class SyncStateCorruptError extends Error {
  readonly code = 'state_corrupt';

  constructor(location: string) {
    super(`Sync state at ${location} is not valid; it was not loaded.`);
    this.name = 'SyncStateCorruptError';
  }
}

export function isSyncStateConflict(error: unknown): error is SyncStateConflictError {
  return error instanceof SyncStateConflictError;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
