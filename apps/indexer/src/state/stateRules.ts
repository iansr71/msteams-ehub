import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  leaseSchema,
  resourceStateSchema,
  storedResourceStateSchema,
  syncJobRecordSchema,
  type Lease,
  type ResourceKey,
  type ResourceState,
  type StoredResourceState,
  type SyncJobRecord,
} from './syncState.js';
import type { LeaseRequest, ResourceStateQuery } from './syncStateRepository.js';
import { SyncStateConflictError } from './syncStateRepository.js';

/*
 * The repository contract as plain functions over in-memory collections, shared by the
 * in-memory and file repositories so both behave identically.
 */

export function resourceMapKey(key: ResourceKey): string {
  return JSON.stringify([key.tenantId, key.courseId, key.resourceId]);
}

export function copyStored(state: StoredResourceState): StoredResourceState {
  return storedResourceStateSchema.parse(structuredClone(state));
}

export function applySave(
  existing: StoredResourceState | undefined,
  state: ResourceState,
  expectedRevision: number | null,
): StoredResourceState {
  const validated = resourceStateSchema.parse(state);
  if (
    expectedRevision === null ? existing !== undefined : existing?.revision !== expectedRevision
  ) {
    throw new SyncStateConflictError();
  }
  return storedResourceStateSchema.parse({
    ...structuredClone(validated),
    revision: (existing?.revision ?? 0) + 1,
  });
}

export function matchesQuery(state: StoredResourceState, query: ResourceStateQuery): boolean {
  return (
    state.tenantId === query.tenantId &&
    (query.courseId === undefined || state.courseId === query.courseId) &&
    (query.statuses === undefined || query.statuses.includes(state.status))
  );
}

export function sortResources(states: StoredResourceState[]): StoredResourceState[] {
  return states.sort(
    (a, b) =>
      a.courseId - b.courseId ||
      (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0),
  );
}

const leaseRequestSchema = z.object({
  name: z.string().min(1).max(300),
  owner: z.string().min(1).max(200),
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(7 * 86_400_000),
});

/** Returns the new lease and the updated lease list, or undefined when another owner holds it. */
export function applyAcquire(
  leases: readonly Lease[],
  request: LeaseRequest,
  now: Date,
): { lease: Lease; leases: Lease[] } | undefined {
  const { name, owner, ttlMs } = leaseRequestSchema.parse(request);
  const current = leases.find((lease) => lease.name === name);
  if (
    current !== undefined &&
    current.owner !== owner &&
    Date.parse(current.expiresAt) > now.getTime()
  ) {
    return undefined;
  }
  const lease = leaseSchema.parse({
    name,
    owner,
    token: randomUUID(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  return { lease, leases: [...leases.filter((entry) => entry.name !== name), lease] };
}

function holds(leases: readonly Lease[], lease: Lease, now: Date): boolean {
  const current = leases.find((entry) => entry.name === lease.name);
  return (
    current?.token === lease.token &&
    current.owner === lease.owner &&
    Date.parse(current.expiresAt) > now.getTime()
  );
}

export function applyRenew(
  leases: readonly Lease[],
  lease: Lease,
  ttlMs: number,
  now: Date,
): { lease: Lease; leases: Lease[] } | undefined {
  if (!holds(leases, lease, now)) {
    return undefined;
  }
  const renewed = leaseSchema.parse({
    ...lease,
    expiresAt: new Date(now.getTime() + leaseRequestSchema.shape.ttlMs.parse(ttlMs)).toISOString(),
  });
  return {
    lease: renewed,
    leases: [...leases.filter((entry) => entry.name !== lease.name), renewed],
  };
}

/** Releasing a lease that was lost or taken over is a no-op. */
export function applyRelease(leases: readonly Lease[], lease: Lease): Lease[] {
  return leases.filter((entry) => !(entry.name === lease.name && entry.token === lease.token));
}

/** Drops expired leases so the list does not grow forever. */
export function pruneLeases(leases: readonly Lease[], now: Date): Lease[] {
  return leases.filter((lease) => Date.parse(lease.expiresAt) > now.getTime());
}

export const MAX_STORED_JOBS = 500;

export function applySaveJob(jobs: readonly SyncJobRecord[], job: SyncJobRecord): SyncJobRecord[] {
  const validated = syncJobRecordSchema.parse(structuredClone(job));
  const others = jobs.filter((entry) => entry.jobId !== validated.jobId);
  return sortJobs([...others, validated]).slice(0, MAX_STORED_JOBS);
}

export function sortJobs(jobs: SyncJobRecord[]): SyncJobRecord[] {
  return jobs.sort((a, b) =>
    a.startedAt === b.startedAt ? (a.jobId < b.jobId ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1,
  );
}
