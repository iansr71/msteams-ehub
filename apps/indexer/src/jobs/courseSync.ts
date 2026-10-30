import type { IndexedChunkKey } from '@ehub/shared/search';

import { CourseNotFoundError } from '../moodle/inspectCourse.js';
import type { CourseStructure } from '../moodle/models.js';
import type { StoredResourceState } from '../state/syncState.js';
import type { DecisionMode } from './changeDetection.js';
import { CourseSyncError, loadCourseStructure, withCourseLease } from './courseAccess.js';
import { exclusionReason } from './changeDetection.js';
import { classifyError } from './failureClassification.js';
import { removeStaleResources } from './staleResources.js';
import { SyncJobAbortedError, type SyncJob } from './syncContext.js';
import { syncListedResource, type CourseSyncContext } from './syncResource.js';

export interface CourseSyncOptions {
  /**
   * - `sync`: decide and apply changes for every listed resource;
   * - `reconcile`: only exclusions and removals (nothing is downloaded).
   */
  readonly scope: 'sync' | 'reconcile';
  readonly mode: DecisionMode;
  /** Also list the course's chunks in the index to find chunks with no state. */
  readonly checkIndex: boolean;
}

async function loadStates(
  job: SyncJob,
  courseId: number,
): Promise<Map<string, StoredResourceState>> {
  const states = await job.services.state.listResources({
    tenantId: job.services.settings.tenantId,
    courseId,
  });
  return new Map(states.map((state) => [state.resourceId, state] as const));
}

async function listIndexKeys(job: SyncJob, courseId: number): Promise<IndexedChunkKey[]> {
  try {
    return await job.services.search.listChunkKeys(
      { tenantId: job.services.settings.tenantId, courseId },
      job.signal === undefined ? {} : { signal: job.signal },
    );
  } catch (error) {
    const classification = classifyError(error);
    throw classification.scope === 'job'
      ? new SyncJobAbortedError(classification.category)
      : new CourseSyncError(classification.category);
  }
}

/**
 * Synchronises one course under its lease: every resource Moodle lists, then removal of the
 * ones it no longer lists. Course-level problems are reported and the job moves on;
 * job-level problems (SyncJobAbortedError) propagate.
 */
export async function syncCourseContents(
  job: SyncJob,
  courseId: number,
  options: CourseSyncOptions,
): Promise<void> {
  await withCourseLease(job, courseId, async (lease) => {
    let structure: CourseStructure;
    try {
      structure = await loadCourseStructure(job, courseId);
    } catch (error) {
      if (error instanceof CourseNotFoundError) {
        // Not removed: a permission change can hide a course temporarily. See docs/sync.md.
        job.report.addCourse({ courseId, outcome: 'not_found' });
        return;
      }
      if (error instanceof CourseSyncError) {
        job.report.addCourse({ courseId, outcome: 'failed', failureCategory: error.category });
        return;
      }
      throw error;
    }

    try {
      const states = await loadStates(job, courseId);
      const context: CourseSyncContext = {
        structure,
        courseHidden: structure.course.visible === false,
        states,
      };
      for (const resource of structure.resources) {
        if (!(await lease.renew())) {
          job.report.addCourse({ courseId, outcome: 'failed', failureCategory: 'lease_lost' });
          return;
        }
        if (
          options.scope === 'reconcile' &&
          exclusionReason(resource, context.courseHidden, job.services.settings.includeHidden) ===
            undefined
        ) {
          continue;
        }
        await syncListedResource(job, context, resource, options.mode);
      }
      const indexKeys = options.checkIndex ? await listIndexKeys(job, courseId) : undefined;
      const blocked = await removeStaleResources(job, {
        courseId,
        listedIds: new Set(structure.resources.map((resource) => resource.resourceId)),
        states,
        ...(indexKeys === undefined ? {} : { indexKeys }),
        reason: 'deleted',
      });
      job.report.addCourse({
        courseId,
        outcome: options.scope === 'reconcile' ? 'reconciled' : 'synced',
        ...(blocked > 0 ? { deletionGuardBlocked: blocked } : {}),
      });
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
 * Removes everything indexed for courses that are no longer selected (or, with
 * SYNC_ALL_COURSES, no longer visible to the service account). Guarded like resource removal.
 */
export async function removeUnselectedCourses(
  job: SyncJob,
  selectedIds: ReadonlySet<number>,
): Promise<void> {
  const { services } = job;
  const tenantId = services.settings.tenantId;
  let indexKeys: IndexedChunkKey[];
  try {
    indexKeys = await services.search.listChunkKeys(
      { tenantId },
      job.signal === undefined ? {} : { signal: job.signal },
    );
  } catch (error) {
    const classification = classifyError(error);
    if (classification.scope === 'job') {
      throw new SyncJobAbortedError(classification.category);
    }
    job.report.warn(`index_listing_failed:${classification.category}`);
    return;
  }
  const stateCourses = await services.state.listCourseIds(tenantId);
  const indexedCourses = new Set([...indexKeys.map((key) => key.courseId), ...stateCourses]);
  const unselected = [...indexedCourses].filter((id) => !selectedIds.has(id)).sort((a, b) => a - b);
  if (unselected.length === 0) {
    return;
  }
  const coursesWithChunks = new Set(indexKeys.map((key) => key.courseId));
  const removingWithChunks = unselected.filter((id) => coursesWithChunks.has(id)).length;
  // Courses are few, so the guard applies once more than one course with content would go.
  if (!deletionAllowedForCourses(job, removingWithChunks, coursesWithChunks.size)) {
    job.report.warn('deletion_guard');
    for (const courseId of unselected) {
      job.report.addCourse({
        courseId,
        outcome: 'failed',
        failureCategory: 'deletion_guard',
        deletionGuardBlocked: 1,
      });
    }
    return;
  }

  for (const courseId of unselected) {
    await withCourseLease(job, courseId, async () => {
      const states = await loadStates(job, courseId);
      await removeStaleResources(job, {
        courseId,
        listedIds: new Set(),
        states,
        indexKeys: indexKeys.filter((key) => key.courseId === courseId),
        reason: 'course_not_selected',
        // The guard was applied to the set of courses above.
        guard: false,
      });
      job.report.addCourse({
        courseId,
        outcome: job.options.dryRun ? 'would_remove' : 'removed',
      });
    });
  }
}

function deletionAllowedForCourses(job: SyncJob, removing: number, total: number): boolean {
  if (job.options.allowMassDelete || removing <= 1) {
    return true;
  }
  return removing <= job.services.settings.maxDeleteFraction * total;
}
