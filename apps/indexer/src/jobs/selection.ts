import { isMoodleError } from '@ehub/moodle-client';

import { discoverCourses } from '../moodle/discoverCourses.js';
import type { CourseSummary } from '../moodle/models.js';
import { classifyError } from './failureClassification.js';
import { SyncJobAbortedError, SyncSelectionError, type SyncJob } from './syncContext.js';

export interface CourseSelection {
  /** Selected courses Moodle returned, by ID. */
  readonly courses: readonly CourseSummary[];
  /** Explicitly selected IDs Moodle did not return (deleted, or not visible to the service). */
  readonly missing: readonly number[];
  /** Every selected course ID (returned or not): content of these is never removed as deselected. */
  readonly selectedIds: ReadonlySet<number>;
}

/** Resolves SYNC_COURSE_IDS or SYNC_ALL_COURSES against Moodle. */
export async function resolveCourseSelection(job: SyncJob): Promise<CourseSelection> {
  const { services } = job;
  const { settings } = services;
  if (!settings.allCourses && (settings.courseIds?.length ?? 0) === 0) {
    throw new SyncSelectionError('no_course_selection');
  }
  try {
    const result = await discoverCourses(
      services.moodle.client,
      services.moodle.baseUrl,
      settings.allCourses ? {} : { courseIds: settings.courseIds ?? [] },
      job.signal === undefined ? {} : { signal: job.signal },
    );
    const returned = new Set(result.courses.map((course) => course.id));
    const explicit = settings.allCourses ? [] : (settings.courseIds ?? []);
    return {
      courses: result.courses,
      missing: explicit.filter((id) => !returned.has(id)),
      selectedIds: new Set([...returned, ...explicit]),
    };
  } catch (error) {
    if (isMoodleError(error)) {
      // Without the course list nothing can be synchronised safely.
      throw new SyncJobAbortedError(
        classifyError(error).scope === 'job' ? classifyError(error).category : 'moodle_unavailable',
      );
    }
    throw error;
  }
}

/** For jobs on one course: refuses courses outside the selection. */
export function assertCourseSelected(job: SyncJob, courseId: number): void {
  const { settings } = job.services;
  if (settings.allCourses) {
    return;
  }
  if ((settings.courseIds?.length ?? 0) === 0) {
    throw new SyncSelectionError('no_course_selection');
  }
  if (!(settings.courseIds ?? []).includes(courseId)) {
    throw new SyncSelectionError('course_not_selected');
  }
}
