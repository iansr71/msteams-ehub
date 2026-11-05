import type {
  FailureCategory,
  ResourceStatus,
  StoredResourceState,
  SyncJobRecord,
  SyncStateRepository,
} from '@ehub/indexer';
import type { Logger } from '@ehub/shared';

import type { IdentityMappingRepository } from '../authorization/identityMappingRepository.js';
import type { AuditEvent, UsageEvent } from './events.js';
import type { EventStore } from './eventStore.js';
import type { JobRunnerStatus } from './jobRunner.js';

const DAY_MS = 86_400_000;
const FAILURE_STATUSES: readonly ResourceStatus[] = ['failed', 'dead_letter', 'quarantined'];

/** The pipeline stage a failure category belongs to (for the failures page). */
export function failureStage(category: FailureCategory | undefined): string {
  if (category === undefined) {
    return 'unknown';
  }
  if (
    category.startsWith('moodle_') ||
    category === 'file_too_large' ||
    category === 'unsafe_download'
  ) {
    return 'download';
  }
  if (category.startsWith('embedding_')) {
    return 'embedding';
  }
  if (category.startsWith('index_')) {
    return 'indexing';
  }
  if (category === 'state_conflict') {
    return 'state';
  }
  if (category === 'unexpected_error') {
    return 'unknown';
  }
  return category === 'no_indexable_text' || category === 'invalid_chunk'
    ? 'chunking'
    : 'extraction';
}

export interface CourseSelectionSettings {
  readonly tenantId: string;
  /** Undefined when every visible course is synchronised. */
  readonly courseIds: readonly number[] | undefined;
  readonly allCourses: boolean;
  readonly leaseTtlMs: number;
}

/** Course names from Moodle for known course IDs only; undefined names on failure. */
export type CourseNameLookup = (
  courseIds: readonly number[],
) => Promise<ReadonlyMap<number, string>>;

export interface AdminDataOptions {
  readonly state: Pick<SyncStateRepository, 'listResources' | 'listJobs'>;
  readonly selection: CourseSelectionSettings;
  readonly identity?: Pick<
    IdentityMappingRepository,
    'listMappings' | 'listFailures' | 'listObservations'
  >;
  readonly usage: EventStore<UsageEvent>;
  readonly audit: EventStore<AuditEvent>;
  readonly courseNames?: CourseNameLookup;
  readonly runner: () => JobRunnerStatus;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * Read models for the administration pages. Everything returned is IDs, counts, timestamps,
 * Moodle names and fixed codes: never chunk text, error messages or secrets.
 */
export class AdminDataService {
  readonly #options: AdminDataOptions;
  readonly #now: () => Date;
  readonly #logger: Logger;

  constructor(options: AdminDataOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger.child({ component: 'admin-data' });
  }

  get selection(): CourseSelectionSettings {
    return this.#options.selection;
  }

  isCourseIncluded(courseId: number): boolean {
    const { selection } = this.#options;
    return selection.allCourses || (selection.courseIds ?? []).includes(courseId);
  }

  async #resources(): Promise<StoredResourceState[]> {
    return await this.#options.state.listResources({ tenantId: this.#options.selection.tenantId });
  }

  async #names(
    courseIds: readonly number[],
  ): Promise<{ names: ReadonlyMap<number, string>; available: boolean }> {
    if (this.#options.courseNames === undefined || courseIds.length === 0) {
      return { names: new Map(), available: this.#options.courseNames !== undefined };
    }
    try {
      return { names: await this.#options.courseNames(courseIds.slice(0, 500)), available: true };
    } catch (error) {
      this.#logger.warn('Course names could not be read from Moodle.', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { names: new Map(), available: false };
    }
  }

  #job(job: SyncJobRecord): Record<string, unknown> {
    const startedMs = Date.parse(job.startedAt);
    return {
      jobId: job.jobId,
      jobType: job.jobType,
      status: job.status,
      dryRun: job.dryRun,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      correlationId: job.correlationId ?? null,
      // A crashed process leaves a job "running"; flag it once its lease would have expired.
      possiblyStale:
        job.status === 'running' &&
        this.#now().getTime() - startedMs > this.#options.selection.leaseTtlMs,
      summary: {
        courses: job.courseIds.length,
        ...job.counts,
        failureCategory: job.failureCategory ?? null,
      },
    };
  }

  async dashboard(): Promise<Record<string, unknown>> {
    const [resources, jobs] = await Promise.all([
      this.#resources(),
      this.#options.state.listJobs(100),
    ]);
    const count = (status: ResourceStatus) => resources.filter((r) => r.status === status).length;
    const now = this.#now().getTime();
    const usage = await this.#options.usage.read(new Date(now - 30 * DAY_MS));
    const weekStart = now - 7 * DAY_MS;
    const answers = usage.events.filter(
      (event) => event.kind === 'answer' && Date.parse(event.at) >= weekStart,
    );
    const feedback = usage.events.filter(
      (event): event is Extract<UsageEvent, { kind: 'feedback' }> => event.kind === 'feedback',
    );
    const statusCount = (status: string) =>
      answers.filter((event) => event.kind === 'answer' && event.status === status).length;
    const lastSuccessful = jobs.find((job) => job.status === 'succeeded' && !job.dryRun);
    const last = jobs.find((job) => job.status !== 'running' && !job.dryRun);
    const { selection } = this.#options;
    return {
      lastSuccessfulSync: lastSuccessful === undefined ? null : this.#job(lastSuccessful),
      lastSync: last === undefined ? null : this.#job(last),
      activeSyncs: jobs.filter((job) => job.status === 'running').map((job) => this.#job(job)),
      runner: this.#options.runner(),
      courses: {
        selection: selection.allCourses ? 'all' : 'explicit',
        included: selection.allCourses ? null : [...(selection.courseIds ?? [])],
        withContent: new Set(resources.filter((r) => r.status === 'indexed').map((r) => r.courseId))
          .size,
      },
      resources: {
        indexed: count('indexed'),
        skipped: count('excluded'),
        failures: {
          failed: count('failed'),
          deadLetter: count('dead_letter'),
          quarantined: count('quarantined'),
        },
        removed: count('removed'),
      },
      answers: {
        days: 7,
        answered: statusCount('answered'),
        insufficientEvidence: statusCount('insufficient_evidence'),
        failed: statusCount('failed'),
      },
      feedback: {
        days: 30,
        useful: feedback.filter((event) => event.rating === 'useful').length,
        notUseful: feedback.filter((event) => event.rating === 'not_useful').length,
      },
      unreadableEvents: usage.invalid,
    };
  }

  async courses(): Promise<Record<string, unknown>> {
    const resources = await this.#resources();
    const { selection } = this.#options;
    const ids = new Set<number>([
      ...(selection.courseIds ?? []),
      ...resources.map((r) => r.courseId),
    ]);
    const sorted = [...ids].sort((a, b) => a - b);
    const { names, available } = await this.#names(sorted);
    return {
      selection: selection.allCourses ? 'all' : 'explicit',
      namesAvailable: available,
      courses: sorted.map((courseId) => {
        const own = resources.filter((r) => r.courseId === courseId);
        const indexedTimes = own
          .map((r) => r.lastSuccessfulIndexAt)
          .filter((value): value is string => value !== undefined)
          .sort();
        const included = this.isCourseIncluded(courseId);
        return {
          courseId,
          name: names.get(courseId) ?? null,
          inclusion: included ? 'included' : 'not_selected',
          lastIndexedAt: indexedTimes.at(-1) ?? null,
          resourceCount: own.filter((r) => r.status === 'indexed').length,
          failureCount: own.filter((r) => FAILURE_STATUSES.includes(r.status)).length,
          canReindex: included,
        };
      }),
    };
  }

  async jobs(limit: number): Promise<Record<string, unknown>> {
    const jobs = await this.#options.state.listJobs(limit);
    return { runner: this.#options.runner(), jobs: jobs.map((job) => this.#job(job)) };
  }

  async failures(): Promise<Record<string, unknown>> {
    const failing = (await this.#resources())
      .filter((r) => FAILURE_STATUSES.includes(r.status))
      .sort((a, b) => a.courseId - b.courseId || a.resourceId.localeCompare(b.resourceId));
    const { names } = await this.#names([...new Set(failing.map((r) => r.courseId))]);
    return {
      failures: failing.map((r) => ({
        courseId: r.courseId,
        courseName: names.get(r.courseId) ?? null,
        resourceId: r.resourceId,
        moduleId: r.moduleId,
        status: r.status,
        stage: failureStage(r.failureCategory),
        category: r.failureCategory ?? null,
        retryCount: r.retryCount,
        nextRetryAt: r.nextRetryAt ?? null,
        lastAttemptAt: r.lastAttemptAt ?? null,
        canRetry: this.isCourseIncluded(r.courseId),
      })),
    };
  }

  async isFailing(courseId: number, resourceId: string): Promise<boolean> {
    const resources = await this.#options.state.listResources({
      tenantId: this.#options.selection.tenantId,
      courseId,
      statuses: FAILURE_STATUSES,
    });
    return resources.some((r) => r.resourceId === resourceId);
  }

  async identity(): Promise<Record<string, unknown>> {
    const { identity } = this.#options;
    if (identity === undefined) {
      return { available: false, mappings: [], recentFailures: [], observedUsers: 0 };
    }
    const [mappings, failures, observations] = await Promise.all([
      identity.listMappings(),
      identity.listFailures({ limit: 200 }),
      identity.listObservations(),
    ]);
    return {
      available: true,
      mappings: mappings.map((mapping) => ({
        entraObjectId: mapping.objectId,
        moodleUserId: mapping.moodleUserId,
        method: 'explicit',
        status: 'approved',
        approvedBy: mapping.approvedBy,
        approvedAt: mapping.approvedAt,
        reference: mapping.reference ?? null,
      })),
      recentFailures: failures.map((failure) => ({
        entraObjectId: failure.objectId,
        status: 'denied',
        reason: failure.reason,
        method: failure.method ?? null,
        candidates: failure.candidates ?? null,
        accountType: failure.accountType ?? null,
        at: failure.at,
      })),
      observedUsers: observations.length,
    };
  }

  async audit(days: number, limit: number): Promise<Record<string, unknown>> {
    const { events, invalid } = await this.#options.audit.read(
      new Date(this.#now().getTime() - days * DAY_MS),
    );
    return { days, unreadable: invalid, events: [...events].reverse().slice(0, limit) };
  }
}
