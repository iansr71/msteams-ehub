import {
  applyAcquire,
  applyRelease,
  applyRenew,
  applySave,
  applySaveJob,
  copyStored,
  matchesQuery,
  pruneLeases,
  resourceMapKey,
  sortResources,
} from './stateRules.js';
import type {
  Lease,
  ResourceKey,
  ResourceState,
  StoredResourceState,
  SyncJobRecord,
} from './syncState.js';
import {
  systemClock,
  type Clock,
  type LeaseRequest,
  type ResourceStateQuery,
  type SyncStateRepository,
} from './syncStateRepository.js';

/** For tests and single-process runs; state is lost when the process exits. */
export class InMemorySyncStateRepository implements SyncStateRepository {
  readonly #resources = new Map<string, StoredResourceState>();
  #leases: Lease[] = [];
  #jobs: SyncJobRecord[] = [];
  readonly #clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  getResource(key: ResourceKey): Promise<StoredResourceState | undefined> {
    const found = this.#resources.get(resourceMapKey(key));
    return Promise.resolve(found === undefined ? undefined : copyStored(found));
  }

  listResources(query: ResourceStateQuery): Promise<StoredResourceState[]> {
    return Promise.resolve(
      sortResources(
        [...this.#resources.values()].filter((state) => matchesQuery(state, query)).map(copyStored),
      ),
    );
  }

  listCourseIds(tenantId: string): Promise<number[]> {
    const ids = new Set<number>();
    for (const state of this.#resources.values()) {
      if (state.tenantId === tenantId) {
        ids.add(state.courseId);
      }
    }
    return Promise.resolve([...ids].sort((a, b) => a - b));
  }

  async saveResource(
    state: ResourceState,
    expectedRevision: number | null,
  ): Promise<StoredResourceState> {
    await Promise.resolve();
    const key = resourceMapKey(state);
    const stored = applySave(this.#resources.get(key), state, expectedRevision);
    this.#resources.set(key, stored);
    return copyStored(stored);
  }

  acquireLease(request: LeaseRequest): Promise<Lease | undefined> {
    const now = this.#clock.now();
    const result = applyAcquire(pruneLeases(this.#leases, now), request, now);
    if (result === undefined) {
      return Promise.resolve(undefined);
    }
    this.#leases = result.leases;
    return Promise.resolve(result.lease);
  }

  renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined> {
    const result = applyRenew(this.#leases, lease, ttlMs, this.#clock.now());
    if (result === undefined) {
      return Promise.resolve(undefined);
    }
    this.#leases = result.leases;
    return Promise.resolve(result.lease);
  }

  releaseLease(lease: Lease): Promise<void> {
    this.#leases = applyRelease(this.#leases, lease);
    return Promise.resolve();
  }

  async saveJob(job: SyncJobRecord): Promise<void> {
    await Promise.resolve();
    this.#jobs = applySaveJob(this.#jobs, job);
  }

  getJob(jobId: string): Promise<SyncJobRecord | undefined> {
    const job = this.#jobs.find((entry) => entry.jobId === jobId);
    return Promise.resolve(job === undefined ? undefined : structuredClone(job));
  }

  listJobs(limit: number): Promise<SyncJobRecord[]> {
    return Promise.resolve(
      this.#jobs.slice(0, Math.max(0, limit)).map((job) => structuredClone(job)),
    );
  }
}
