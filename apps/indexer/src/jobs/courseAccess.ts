import { isMoodleError } from '@ehub/moodle-client';

import { inspectCourse } from '../moodle/inspectCourse.js';
import type { CourseStructure } from '../moodle/models.js';
import { courseLeaseName, type Lease } from '../state/syncState.js';
import { classifyError } from './failureClassification.js';
import { SyncJobAbortedError, type SyncJob } from './syncContext.js';

/** A course-level problem (Moodle refused or failed to list the course); other courses go on. */
export class CourseSyncError extends Error {
  constructor(readonly category: string) {
    super(`The course could not be synchronised: ${category}.`);
    this.name = 'CourseSyncError';
  }
}

/** Reads one course's structure; job-wide Moodle failures stop the job. */
export async function loadCourseStructure(
  job: SyncJob,
  courseId: number,
): Promise<CourseStructure> {
  const { services } = job;
  try {
    const { structure } = await inspectCourse(
      services.moodle.client,
      services.moodle.baseUrl,
      courseId,
      {
        maxFileBytes: services.settings.maxDownloadBytes,
        ...(job.signal === undefined ? {} : { signal: job.signal }),
      },
    );
    return structure;
  } catch (error) {
    if (!isMoodleError(error)) {
      throw error;
    }
    const classification = classifyError(error);
    if (classification.scope === 'job') {
      throw new SyncJobAbortedError(classification.category);
    }
    throw new CourseSyncError(classification.category);
  }
}

export interface LeaseHandle {
  /** Extends the lease; false when it was lost (expired and taken by another job). */
  renew(): Promise<boolean>;
}

const DRY_RUN_LEASE: LeaseHandle = { renew: () => Promise.resolve(true) };

/**
 * Runs `action` while holding the course's lease, so two jobs never sync the same course (or a
 * resource in it) at once. A course held by another job is reported as `locked` and skipped.
 * Dry runs take no lease: they write nothing.
 */
export async function withCourseLease(
  job: SyncJob,
  courseId: number,
  action: (lease: LeaseHandle) => Promise<void>,
): Promise<void> {
  if (job.options.dryRun) {
    await action(DRY_RUN_LEASE);
    return;
  }
  const { services } = job;
  const ttlMs = services.settings.leaseTtlMs;
  const acquired: Lease | undefined = await services.state.acquireLease({
    name: courseLeaseName(services.settings.tenantId, courseId),
    owner: job.jobId,
    ttlMs,
  });
  if (acquired === undefined) {
    job.report.addCourse({ courseId, outcome: 'locked' });
    job.logger.warn('Course is being synchronised by another job; skipped.', { courseId });
    return;
  }
  // Mutable holder: renew() replaces the lease (new expiry) or clears it when it was lost.
  const held: { lease: Lease | undefined } = { lease: acquired };
  const handle: LeaseHandle = {
    renew: async () => {
      if (held.lease === undefined) {
        return false;
      }
      held.lease = await services.state.renewLease(held.lease, ttlMs);
      return held.lease !== undefined;
    },
  };
  try {
    await action(handle);
  } finally {
    if (held.lease !== undefined) {
      await services.state.releaseLease(held.lease);
    }
  }
}
