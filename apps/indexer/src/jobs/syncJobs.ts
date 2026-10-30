import { randomUUID } from 'node:crypto';

import { getCorrelationId } from '@ehub/shared';

import type { StoredResourceState, SyncJobRecord, SyncJobType } from '../state/syncState.js';
import { classifyError } from './failureClassification.js';
import { removeUnselectedCourses, syncCourseContents } from './courseSync.js';
import { CourseSyncError, loadCourseStructure, withCourseLease } from './courseAccess.js';
import { assertCourseSelected, resolveCourseSelection } from './selection.js';
import {
  DEFAULT_JOB_OPTIONS,
  SyncJobAbortedError,
  SyncSelectionError,
  type JobOptions,
  type SyncJob,
  type SyncServices,
} from './syncContext.js';
import { SyncReportBuilder, type SyncReport } from './syncReport.js';
import { removeResource, syncListedResource, syncSingleResource } from './syncResource.js';
import { CourseNotFoundError, ResourceNotFoundError } from '../moodle/inspectCourse.js';

export interface RunOptions extends Partial<JobOptions> {
  readonly signal?: AbortSignal;
  /** For tests; a random UUID otherwise. */
  readonly jobId?: string;
}

/**
 * Runs a job body with a job record, a report and a job-scoped logger. Jobs are idempotent:
 * state records what is indexed, unchanged resources are skipped, and chunk keys are
 * deterministic, so running the same job again (or after a crash) converges on the same index.
 * Selection errors and unknown resource IDs are rethrown; everything else ends in a report.
 */
async function runJob(
  services: SyncServices,
  jobType: SyncJobType,
  runOptions: RunOptions,
  body: (job: SyncJob) => Promise<void>,
): Promise<SyncReport> {
  const options: JobOptions = {
    dryRun: runOptions.dryRun ?? DEFAULT_JOB_OPTIONS.dryRun,
    force: runOptions.force ?? DEFAULT_JOB_OPTIONS.force,
    allowMassDelete: runOptions.allowMassDelete ?? DEFAULT_JOB_OPTIONS.allowMassDelete,
    includeDeadLetter: runOptions.includeDeadLetter ?? DEFAULT_JOB_OPTIONS.includeDeadLetter,
  };
  const jobId = runOptions.jobId ?? randomUUID();
  const startedAt = services.clock.now();
  const logger = services.logger.child({ jobId, jobType, dryRun: options.dryRun });
  const report = new SyncReportBuilder(jobId, jobType, options.dryRun, startedAt);
  const job: SyncJob = {
    jobId,
    jobType,
    options,
    services,
    report,
    logger,
    ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
  };
  const correlationId = getCorrelationId();
  const record = (
    status: SyncJobRecord['status'],
    finishedAt?: Date,
    failureCategory?: string,
  ): SyncJobRecord => ({
    jobId,
    jobType,
    tenantId: services.settings.tenantId,
    status,
    dryRun: options.dryRun,
    ...(correlationId === undefined ? {} : { correlationId }),
    startedAt: startedAt.toISOString(),
    ...(finishedAt === undefined ? {} : { finishedAt: finishedAt.toISOString() }),
    courseIds: report.courseIds(),
    counts: report.counts(),
    ...(failureCategory === undefined ? {} : { failureCategory }),
  });

  logger.info('Sync job started.', { force: options.force });
  if (!options.dryRun) {
    await services.state.saveJob(record('running'));
  }
  let failureCategory: string | undefined;
  try {
    await body(job);
  } catch (error) {
    // Caller mistakes, not sync failures: nothing was changed.
    if (error instanceof SyncSelectionError || error instanceof ResourceNotFoundError) {
      throw error;
    }
    failureCategory =
      error instanceof SyncJobAbortedError ? error.category : classifyError(error).category;
    logger.error('Sync job stopped.', {
      failureCategory,
      ...(error instanceof SyncJobAbortedError ? {} : { err: error }),
    });
  }
  const finishedAt = services.clock.now();
  const result = report.build(finishedAt, failureCategory);
  if (!options.dryRun) {
    await services.state.saveJob(record(result.status, finishedAt, failureCategory));
  }
  logger.info('Sync job finished.', {
    status: result.status,
    ...result.counts,
    durationMs: result.durationMs,
  });
  return result;
}

/**
 * Every selected course; every indexed resource is downloaded and hashed (`verify`) so changes
 * Moodle's timestamps miss are caught; the index is checked for chunks with no state; and
 * courses no longer selected are removed.
 */
export function fullSync(services: SyncServices, options: RunOptions = {}): Promise<SyncReport> {
  return runJob(services, 'full', options, async (job) => {
    const selection = await resolveCourseSelection(job);
    for (const courseId of selection.missing) {
      job.report.addCourse({ courseId, outcome: 'not_found' });
    }
    for (const course of selection.courses) {
      await syncCourseContents(job, course.id, { scope: 'sync', mode: 'full', checkIndex: true });
    }
    await removeUnselectedCourses(job, selection.selectedIds);
  });
}

/** Every selected course; only resources whose Moodle metadata or pipeline versions changed. */
export function incrementalSync(
  services: SyncServices,
  options: RunOptions = {},
): Promise<SyncReport> {
  return runJob(services, 'incremental', options, async (job) => {
    const selection = await resolveCourseSelection(job);
    for (const courseId of selection.missing) {
      job.report.addCourse({ courseId, outcome: 'not_found' });
    }
    for (const course of selection.courses) {
      await syncCourseContents(job, course.id, {
        scope: 'sync',
        mode: 'incremental',
        checkIndex: false,
      });
    }
  });
}

/** One selected course (incremental; `verify` downloads and hashes every indexed resource). */
export function syncCourse(
  services: SyncServices,
  courseId: number,
  options: RunOptions & { readonly verify?: boolean } = {},
): Promise<SyncReport> {
  return runJob(services, 'course', options, async (job) => {
    assertCourseSelected(job, courseId);
    await syncCourseContents(job, courseId, {
      scope: 'sync',
      mode: options.verify === true ? 'full' : 'incremental',
      checkIndex: options.verify === true,
    });
  });
}

/** One resource of a selected course. */
export function syncResource(
  services: SyncServices,
  courseId: number,
  resourceId: string,
  options: RunOptions = {},
): Promise<SyncReport> {
  return runJob(services, 'resource', options, async (job) => {
    assertCourseSelected(job, courseId);
    try {
      await syncSingleResource(job, courseId, resourceId);
    } catch (error) {
      if (error instanceof CourseSyncError) {
        job.report.addCourse({ courseId, outcome: 'failed', failureCategory: error.category });
        return;
      }
      throw error;
    }
  });
}

/**
 * Retries resources that failed with a transient error, now (ignoring the backoff), in selected
 * courses. Quarantined resources are never retried here; dead-lettered ones only with
 * `includeDeadLetter`.
 */
export function retryFailedResources(
  services: SyncServices,
  options: RunOptions = {},
): Promise<SyncReport> {
  return runJob(services, 'retry-failed', options, async (job) => {
    const { settings } = services;
    const failed = await services.state.listResources({
      tenantId: settings.tenantId,
      statuses: job.options.includeDeadLetter ? ['failed', 'dead_letter'] : ['failed'],
    });
    const byCourse = new Map<number, StoredResourceState[]>();
    for (const state of failed) {
      byCourse.set(state.courseId, [...(byCourse.get(state.courseId) ?? []), state]);
    }
    for (const [courseId, candidates] of byCourse) {
      if (!settings.allCourses && !(settings.courseIds ?? []).includes(courseId)) {
        // Reconciliation removes content of unselected courses; retrying it would re-add it.
        for (const state of candidates) {
          job.report.addResource({
            courseId,
            resourceId: state.resourceId,
            action: 'skipped',
            reasons: ['course_not_selected'],
          });
        }
        continue;
      }
      await withCourseLease(job, courseId, async (lease) => {
        let structure;
        try {
          structure = await loadCourseStructure(job, courseId);
        } catch (error) {
          if (error instanceof CourseNotFoundError) {
            job.report.addCourse({ courseId, outcome: 'not_found' });
            return;
          }
          if (error instanceof CourseSyncError) {
            job.report.addCourse({ courseId, outcome: 'failed', failureCategory: error.category });
            return;
          }
          throw error;
        }
        const states = new Map(
          (await services.state.listResources({ tenantId: settings.tenantId, courseId })).map(
            (state) => [state.resourceId, state] as const,
          ),
        );
        const listed = new Map(
          structure.resources.map((resource) => [resource.resourceId, resource]),
        );
        const context = { structure, courseHidden: structure.course.visible === false, states };
        for (const candidate of candidates) {
          if (!(await lease.renew())) {
            job.report.addCourse({ courseId, outcome: 'failed', failureCategory: 'lease_lost' });
            return;
          }
          const resource = listed.get(candidate.resourceId);
          const current = states.get(candidate.resourceId);
          if (
            current === undefined ||
            (current.status !== 'failed' && current.status !== 'dead_letter')
          ) {
            // Another job dealt with it since the list was read.
            continue;
          }
          if (resource === undefined) {
            await removeResource(job, states, current, 'deleted');
          } else {
            await syncListedResource(job, context, resource, 'retry');
          }
        }
        job.report.addCourse({ courseId, outcome: 'synced' });
      });
    }
  });
}

/**
 * Reconciliation: removes chunks of resources Moodle no longer lists, of hidden or unsupported
 * resources, chunks with no state, and courses no longer selected. Downloads nothing.
 */
export function deleteStaleResources(
  services: SyncServices,
  options: RunOptions = {},
): Promise<SyncReport> {
  return runJob(services, 'reconcile', options, async (job) => {
    const selection = await resolveCourseSelection(job);
    for (const courseId of selection.missing) {
      job.report.addCourse({ courseId, outcome: 'not_found' });
    }
    for (const course of selection.courses) {
      await syncCourseContents(job, course.id, {
        scope: 'reconcile',
        mode: 'incremental',
        checkIndex: true,
      });
    }
    await removeUnselectedCourses(job, selection.selectedIds);
  });
}
