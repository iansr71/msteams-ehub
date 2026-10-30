import { describe, expect, it } from 'vitest';

import type { ResourceState, SyncJobRecord } from '../syncState.js';
import { SyncStateConflictError, type SyncStateRepository } from '../syncStateRepository.js';

export const TENANT = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

export function sampleState(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    tenantId: TENANT,
    courseId: 12,
    resourceId: '601:page',
    moduleId: 601,
    status: 'indexed',
    observed: { moodleModifiedAt: '2026-01-01T00:00:00.000Z', metadataHash: HASH },
    retryCount: 0,
    lastJobId: 'job-1',
    lastJobType: 'incremental',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function sampleJob(overrides: Partial<SyncJobRecord> = {}): SyncJobRecord {
  return {
    jobId: 'job-1',
    jobType: 'incremental',
    tenantId: TENANT,
    status: 'running',
    dryRun: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    courseIds: [12],
    counts: { processed: 0, skipped: 0, updated: 0, removed: 0, failed: 0 },
    ...overrides,
  };
}

export interface ContractHarness {
  readonly repository: SyncStateRepository;
  /** Moves the repository's clock forward. */
  readonly advance: (ms: number) => void;
  /** A second handle on the same store (another process), when the implementation has one. */
  readonly reopen?: () => SyncStateRepository;
}

/**
 * The behaviour every SyncStateRepository must have. Production implementations (Azure SQL,
 * PostgreSQL, Azure Table Storage) should run this suite against an emulator.
 */
export function describeSyncStateRepositoryContract(
  name: string,
  create: () => Promise<ContractHarness> | ContractHarness,
): void {
  describe(`${name} (SyncStateRepository contract)`, () => {
    it('creates, reads and replaces a record with increasing revisions', async () => {
      const { repository } = await create();
      const created = await repository.saveResource(sampleState(), null);
      expect(created.revision).toBe(1);
      const updated = await repository.saveResource(
        sampleState({ status: 'failed', retryCount: 1, failureCategory: 'moodle_unavailable' }),
        created.revision,
      );
      expect(updated.revision).toBe(2);
      expect(
        await repository.getResource({ tenantId: TENANT, courseId: 12, resourceId: '601:page' }),
      ).toMatchObject({ status: 'failed', retryCount: 1, revision: 2 });
    });

    it('rejects a create when the record exists and an update with a stale revision', async () => {
      const { repository } = await create();
      await repository.saveResource(sampleState(), null);
      await expect(repository.saveResource(sampleState(), null)).rejects.toBeInstanceOf(
        SyncStateConflictError,
      );
      await repository.saveResource(sampleState({ retryCount: 1 }), 1);
      await expect(
        repository.saveResource(sampleState({ retryCount: 2 }), 1),
      ).rejects.toBeInstanceOf(SyncStateConflictError);
      await expect(repository.saveResource(sampleState(), 7)).rejects.toBeInstanceOf(
        SyncStateConflictError,
      );
    });

    it('rejects an update of a record that does not exist', async () => {
      const { repository } = await create();
      await expect(repository.saveResource(sampleState(), 1)).rejects.toBeInstanceOf(
        SyncStateConflictError,
      );
    });

    it('validates records before storing them', async () => {
      const { repository } = await create();
      await expect(
        repository.saveResource(sampleState({ retryCount: -1 }), null),
      ).rejects.toThrow();
      expect(
        await repository.getResource({ tenantId: TENANT, courseId: 12, resourceId: '601:page' }),
      ).toBeUndefined();
    });

    it('returns copies that do not alias stored state', async () => {
      const { repository } = await create();
      await repository.saveResource(sampleState(), null);
      const first = await repository.getResource({
        tenantId: TENANT,
        courseId: 12,
        resourceId: '601:page',
      });
      if (first === undefined) {
        throw new Error('missing');
      }
      (first as { status: string }).status = 'removed';
      expect(
        (await repository.getResource({ tenantId: TENANT, courseId: 12, resourceId: '601:page' }))
          ?.status,
      ).toBe('indexed');
    });

    it('lists by tenant, course and status in a stable order', async () => {
      const { repository } = await create();
      await repository.saveResource(
        sampleState({ courseId: 15, resourceId: '9:page', moduleId: 9 }),
        null,
      );
      await repository.saveResource(
        sampleState({ resourceId: '702:file:/b.pdf', moduleId: 702 }),
        null,
      );
      await repository.saveResource(
        sampleState({ resourceId: '701:chapter:1', moduleId: 701, status: 'failed' }),
        null,
      );
      await repository.saveResource(
        sampleState({ tenantId: 'other-tenant', resourceId: '1:page', moduleId: 1 }),
        null,
      );
      const all = await repository.listResources({ tenantId: TENANT });
      expect(all.map((state) => `${String(state.courseId)} ${state.resourceId}`)).toEqual([
        '12 701:chapter:1',
        '12 702:file:/b.pdf',
        '15 9:page',
      ]);
      expect(
        (
          await repository.listResources({ tenantId: TENANT, courseId: 12, statuses: ['failed'] })
        ).map((state) => state.resourceId),
      ).toEqual(['701:chapter:1']);
      expect(await repository.listCourseIds(TENANT)).toEqual([12, 15]);
      expect(await repository.listCourseIds('nobody')).toEqual([]);
    });

    it('keeps resource IDs with slashes, spaces and unicode intact', async () => {
      const { repository } = await create();
      const resourceId = '702:file:/sub folder/Aftercare – v2 (final).pdf';
      await repository.saveResource(sampleState({ resourceId, moduleId: 702 }), null);
      expect(
        (await repository.getResource({ tenantId: TENANT, courseId: 12, resourceId }))?.resourceId,
      ).toBe(resourceId);
    });

    it('grants a lease to one owner at a time until it expires', async () => {
      const { repository, advance } = await create();
      const first = await repository.acquireLease({
        name: 'course:t:12',
        owner: 'job-a',
        ttlMs: 60_000,
      });
      expect(first).toBeDefined();
      expect(
        await repository.acquireLease({ name: 'course:t:12', owner: 'job-b', ttlMs: 60_000 }),
      ).toBeUndefined();
      expect(
        await repository.acquireLease({ name: 'course:t:15', owner: 'job-b', ttlMs: 60_000 }),
      ).toBeDefined();
      advance(60_001);
      const taken = await repository.acquireLease({
        name: 'course:t:12',
        owner: 'job-b',
        ttlMs: 60_000,
      });
      expect(taken?.owner).toBe('job-b');
      // The first holder lost the lease: renewing fails and releasing does not free job-b's lease.
      if (first === undefined || taken === undefined) {
        throw new Error('missing lease');
      }
      expect(await repository.renewLease(first, 60_000)).toBeUndefined();
      await repository.releaseLease(first);
      expect(
        await repository.acquireLease({ name: 'course:t:12', owner: 'job-c', ttlMs: 60_000 }),
      ).toBeUndefined();
      await repository.releaseLease(taken);
      expect(
        await repository.acquireLease({ name: 'course:t:12', owner: 'job-c', ttlMs: 60_000 }),
      ).toBeDefined();
    });

    it('renews a held lease', async () => {
      const { repository, advance } = await create();
      const lease = await repository.acquireLease({
        name: 'course:t:1',
        owner: 'job-a',
        ttlMs: 60_000,
      });
      if (lease === undefined) {
        throw new Error('missing lease');
      }
      advance(50_000);
      const renewed = await repository.renewLease(lease, 60_000);
      expect(renewed).toBeDefined();
      advance(50_000);
      expect(
        await repository.acquireLease({ name: 'course:t:1', owner: 'job-b', ttlMs: 60_000 }),
      ).toBeUndefined();
    });

    it('stores job records, most recent first', async () => {
      const { repository } = await create();
      await repository.saveJob(sampleJob());
      await repository.saveJob(
        sampleJob({ jobId: 'job-2', startedAt: '2026-01-02T00:00:00.000Z' }),
      );
      await repository.saveJob(
        sampleJob({ status: 'succeeded', finishedAt: '2026-01-01T01:00:00.000Z' }),
      );
      expect((await repository.listJobs(10)).map((job) => job.jobId)).toEqual(['job-2', 'job-1']);
      expect(await repository.getJob('job-1')).toMatchObject({ status: 'succeeded' });
      expect(await repository.getJob('missing')).toBeUndefined();
      expect(await repository.listJobs(1)).toHaveLength(1);
    });

    it('shares state between handles on the same store', async () => {
      const harness = await create();
      if (harness.reopen === undefined) {
        return;
      }
      await harness.repository.saveResource(sampleState(), null);
      const other = harness.reopen();
      await expect(other.saveResource(sampleState(), null)).rejects.toBeInstanceOf(
        SyncStateConflictError,
      );
      const lease = await harness.repository.acquireLease({
        name: 'course:t:12',
        owner: 'job-a',
        ttlMs: 60_000,
      });
      expect(lease).toBeDefined();
      expect(
        await other.acquireLease({ name: 'course:t:12', owner: 'job-b', ttlMs: 60_000 }),
      ).toBeUndefined();
    });
  });
}
