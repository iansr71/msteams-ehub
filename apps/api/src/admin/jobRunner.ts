import { randomUUID } from 'node:crypto';

import {
  incrementalSync,
  syncCourse,
  syncResource,
  type SyncReport,
  type SyncServices,
} from '@ehub/indexer';
import { runWithCorrelationId, type Logger } from '@ehub/shared';

export type ManualJob =
  | { readonly kind: 'incremental' }
  | { readonly kind: 'reindex'; readonly courseId: number }
  | { readonly kind: 'retry'; readonly courseId: number; readonly resourceId: string };

export interface JobRunnerStatus {
  readonly busy: boolean;
  readonly current: {
    readonly jobId: string;
    readonly kind: ManualJob['kind'];
    readonly startedAt: string;
  } | null;
  readonly last: {
    readonly jobId: string;
    readonly kind: ManualJob['kind'];
    readonly finishedAt: string;
    /** The job's own status, or `setup_failed` when it could not start. */
    readonly status: string;
    readonly failureCategory: string | null;
  } | null;
}

export class JobRunnerBusyError extends Error {
  constructor() {
    super('A manual job is already running.');
    this.name = 'JobRunnerBusyError';
  }
}

export interface JobRunnerOptions {
  /** Opens the indexer services (Moodle, extraction, embeddings, search, sync state). */
  readonly openServices: () => Promise<SyncServices>;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** For tests: replaces the indexer job functions. */
  readonly run?: (services: SyncServices, job: ManualJob, jobId: string) => Promise<SyncReport>;
}

function runIndexerJob(services: SyncServices, job: ManualJob, jobId: string): Promise<SyncReport> {
  switch (job.kind) {
    case 'incremental':
      return incrementalSync(services, { jobId });
    case 'reindex':
      // Re-index: reprocess every resource of the course, whatever its state.
      return syncCourse(services, job.courseId, { jobId, force: true });
    case 'retry':
      return syncResource(services, job.courseId, job.resourceId, { jobId });
  }
}

/**
 * Runs administrator-started sync jobs in this process, one at a time, in the background. Jobs
 * use the same course leases as the scheduled CLI jobs, so the two never process a course at
 * the same time; a course another process holds is reported as skipped by the job itself.
 */
export class AdminJobRunner {
  readonly #options: JobRunnerOptions;
  readonly #logger: Logger;
  readonly #now: () => Date;
  #current: JobRunnerStatus['current'] = null;
  #last: JobRunnerStatus['last'] = null;
  #task: Promise<void> | undefined;

  constructor(options: JobRunnerOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'admin-jobs' });
    this.#now = options.now ?? (() => new Date());
  }

  status(): JobRunnerStatus {
    return { busy: this.#current !== null, current: this.#current, last: this.#last };
  }

  /** Starts the job and returns its ID at once. Throws JobRunnerBusyError while one runs. */
  start(job: ManualJob, correlationId: string): { readonly jobId: string } {
    if (this.#current !== null) {
      throw new JobRunnerBusyError();
    }
    const jobId = randomUUID();
    this.#current = { jobId, kind: job.kind, startedAt: this.#now().toISOString() };
    this.#task = runWithCorrelationId(correlationId, async () => {
      let status = 'setup_failed';
      let failureCategory: string | null = null;
      try {
        const services = await this.#options.openServices();
        const report = await (this.#options.run ?? runIndexerJob)(services, job, jobId);
        status = report.status;
        failureCategory = report.failureCategory ?? null;
      } catch (error) {
        failureCategory =
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'unexpected_error';
        this.#logger.error('Manual job could not run.', {
          kind: job.kind,
          failureCategory,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } finally {
        this.#last = {
          jobId,
          kind: job.kind,
          finishedAt: this.#now().toISOString(),
          status,
          failureCategory,
        };
        this.#current = null;
      }
    });
    return { jobId };
  }

  /** Resolves when no job is running (tests and shutdown). */
  async idle(): Promise<void> {
    await this.#task;
  }
}
