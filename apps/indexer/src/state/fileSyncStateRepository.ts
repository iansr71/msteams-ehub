import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  applyAcquire,
  applyRelease,
  applyRenew,
  applySave,
  applySaveJob,
  copyStored,
  matchesQuery,
  pruneLeases,
  sortJobs,
  sortResources,
} from './stateRules.js';
import {
  leaseSchema,
  storedResourceStateSchema,
  syncJobRecordSchema,
  type Lease,
  type ResourceKey,
  type ResourceState,
  type StoredResourceState,
  type SyncJobRecord,
} from './syncState.js';
import {
  SyncStateCorruptError,
  systemClock,
  type Clock,
  type LeaseRequest,
  type ResourceStateQuery,
  type SyncStateRepository,
} from './syncStateRepository.js';

/*
 * Local development store: JSON files under SYNC_STATE_DIR, one per course plus one for
 * leases and one for job records. Every read-modify-write holds a lock file (created with
 * O_EXCL), and files are replaced by rename, so concurrent CLI processes on one machine see
 * consistent state. Not for shared or production use: see docs/sync.md.
 */

const FORMAT_VERSION = 1 as const;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 25;
/** A lock file older than this is from a crashed process and is broken. */
const STALE_LOCK_MS = 60_000;

const courseFileSchema = z.object({
  version: z.literal(FORMAT_VERSION),
  resources: z.array(storedResourceStateSchema),
});
const leaseFileSchema = z.object({
  version: z.literal(FORMAT_VERSION),
  leases: z.array(leaseSchema),
});
const jobFileSchema = z.object({
  version: z.literal(FORMAT_VERSION),
  jobs: z.array(syncJobRecordSchema),
});

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Tenant IDs are GUIDs in practice; anything else is hashed so it is always a safe name. */
function tenantSegment(tenantId: string): string {
  return SAFE_SEGMENT.test(tenantId)
    ? tenantId
    : `h-${createHash('sha256').update(tenantId).digest('hex').slice(0, 32)}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export class FileSyncStateRepository implements SyncStateRepository {
  readonly #root: string;
  readonly #clock: Clock;

  constructor(options: { readonly directory: string; readonly clock?: Clock }) {
    this.#root = options.directory;
    this.#clock = options.clock ?? systemClock;
  }

  // ---------------------------------------------------------------- files

  #courseFile(tenantId: string, courseId: number): string {
    return join(this.#root, 'resources', tenantSegment(tenantId), `${String(courseId)}.json`);
  }

  async #read<T>(file: string, schema: z.ZodType<T>, empty: T): Promise<T> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return empty;
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SyncStateCorruptError(file);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new SyncStateCorruptError(file);
    }
    return parsed.data;
  }

  async #withLock<T>(file: string, action: () => Promise<T>): Promise<T> {
    const lockFile = `${file}.lock`;
    await mkdir(join(file, '..'), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(lockFile, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (error) {
        if (!isExists(error)) {
          throw error;
        }
        try {
          const info = await stat(lockFile);
          if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
            await rm(lockFile, { force: true });
            continue;
          }
        } catch (statError) {
          if (!isNotFound(statError)) {
            throw statError;
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error('Timed out waiting for the sync state lock.', { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    try {
      return await action();
    } finally {
      await rm(lockFile, { force: true });
    }
  }

  async #write(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  async #update<T, R>(
    file: string,
    schema: z.ZodType<T>,
    empty: T,
    mutate: (current: T) => { next: T | undefined; result: R },
  ): Promise<R> {
    return this.#withLock(file, async () => {
      const current = await this.#read(file, schema, empty);
      const { next, result } = mutate(current);
      if (next !== undefined) {
        await this.#write(file, next);
      }
      return result;
    });
  }

  // ---------------------------------------------------------------- resources

  async getResource(key: ResourceKey): Promise<StoredResourceState | undefined> {
    const file = await this.#read(this.#courseFile(key.tenantId, key.courseId), courseFileSchema, {
      version: FORMAT_VERSION,
      resources: [],
    });
    const found = file.resources.find(
      (state) => state.tenantId === key.tenantId && state.resourceId === key.resourceId,
    );
    return found === undefined ? undefined : copyStored(found);
  }

  async listCourseIds(tenantId: string): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(join(this.#root, 'resources', tenantSegment(tenantId)));
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
    return names
      .map((name) => /^([1-9]\d{0,9})\.json$/.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  async listResources(query: ResourceStateQuery): Promise<StoredResourceState[]> {
    const courseIds =
      query.courseId === undefined ? await this.listCourseIds(query.tenantId) : [query.courseId];
    const results: StoredResourceState[] = [];
    for (const courseId of courseIds) {
      const file = await this.#read(this.#courseFile(query.tenantId, courseId), courseFileSchema, {
        version: FORMAT_VERSION,
        resources: [],
      });
      results.push(...file.resources.filter((state) => matchesQuery(state, query)).map(copyStored));
    }
    return sortResources(results);
  }

  async saveResource(
    state: ResourceState,
    expectedRevision: number | null,
  ): Promise<StoredResourceState> {
    return this.#update(
      this.#courseFile(state.tenantId, state.courseId),
      courseFileSchema,
      { version: FORMAT_VERSION, resources: [] },
      (current) => {
        const existing = current.resources.find(
          (entry) => entry.tenantId === state.tenantId && entry.resourceId === state.resourceId,
        );
        const stored = applySave(existing, state, expectedRevision);
        const resources = sortResources([
          ...current.resources.filter((entry) => entry !== existing),
          stored,
        ]);
        return { next: { version: FORMAT_VERSION, resources }, result: copyStored(stored) };
      },
    );
  }

  // ---------------------------------------------------------------- leases

  #leaseFile(): string {
    return join(this.#root, 'leases.json');
  }

  async acquireLease(request: LeaseRequest): Promise<Lease | undefined> {
    return this.#update(
      this.#leaseFile(),
      leaseFileSchema,
      { version: FORMAT_VERSION, leases: [] },
      (current) => {
        const now = this.#clock.now();
        const outcome = applyAcquire(pruneLeases(current.leases, now), request, now);
        return outcome === undefined
          ? { next: undefined, result: undefined }
          : { next: { version: FORMAT_VERSION, leases: outcome.leases }, result: outcome.lease };
      },
    );
  }

  async renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined> {
    return this.#update(
      this.#leaseFile(),
      leaseFileSchema,
      { version: FORMAT_VERSION, leases: [] },
      (current) => {
        const outcome = applyRenew(current.leases, lease, ttlMs, this.#clock.now());
        return outcome === undefined
          ? { next: undefined, result: undefined }
          : { next: { version: FORMAT_VERSION, leases: outcome.leases }, result: outcome.lease };
      },
    );
  }

  async releaseLease(lease: Lease): Promise<void> {
    await this.#update(
      this.#leaseFile(),
      leaseFileSchema,
      { version: FORMAT_VERSION, leases: [] },
      (current) => ({
        next: { version: FORMAT_VERSION, leases: applyRelease(current.leases, lease) },
        result: undefined,
      }),
    );
  }

  // ---------------------------------------------------------------- jobs

  #jobFile(): string {
    return join(this.#root, 'jobs.json');
  }

  async saveJob(job: SyncJobRecord): Promise<void> {
    await this.#update(
      this.#jobFile(),
      jobFileSchema,
      { version: FORMAT_VERSION, jobs: [] },
      (current) => ({
        next: { version: FORMAT_VERSION, jobs: applySaveJob(current.jobs, job) },
        result: undefined,
      }),
    );
  }

  async getJob(jobId: string): Promise<SyncJobRecord | undefined> {
    const file = await this.#read(this.#jobFile(), jobFileSchema, {
      version: FORMAT_VERSION,
      jobs: [],
    });
    return file.jobs.find((job) => job.jobId === jobId);
  }

  async listJobs(limit: number): Promise<SyncJobRecord[]> {
    const file = await this.#read(this.#jobFile(), jobFileSchema, {
      version: FORMAT_VERSION,
      jobs: [],
    });
    return sortJobs(file.jobs).slice(0, Math.max(0, limit));
  }
}
