import type { MoodleClient } from '@ehub/moodle-client';
import { MoodleError } from '@ehub/moodle-client';

import { AuthorizationUnavailableError } from './errors.js';

export type MoodleEnrolmentLookup = Pick<MoodleClient, 'getUserCourses'>;

export interface UserEnrolments {
  /** Courses the user may ask about, sorted. */
  readonly courseIds: readonly number[];
  /** Enrolled courses left out because they are hidden from students. */
  readonly hiddenCourseCount: number;
}

/** At most this many courses are passed on (the search filter limit). */
export const MAX_AUTHORIZED_COURSES = 1_000;

/**
 * A user's courses from Moodle. `core_enrol_get_users_courses` returns active enrolments only
 * (Moodle calls `enrol_get_users_courses($userid, true)`), and only for courses the service
 * account can see. Hidden courses are excluded: students cannot open them in Moodle, so they
 * are not shown here either. A course whose visibility Moodle did not report counts as hidden.
 */
export class MoodleEnrollmentService {
  readonly #moodle: MoodleEnrolmentLookup;

  constructor(moodle: MoodleEnrolmentLookup) {
    this.#moodle = moodle;
  }

  async coursesFor(moodleUserId: number): Promise<UserEnrolments> {
    let courses;
    try {
      courses = await this.#moodle.getUserCourses(moodleUserId);
    } catch (error) {
      throw new AuthorizationUnavailableError(
        error instanceof MoodleError && error.category === 'validation'
          ? 'invalid_moodle_response'
          : 'moodle_unavailable',
        error,
      );
    }
    const visible = new Set<number>();
    let hiddenCourseCount = 0;
    for (const course of courses) {
      if (course.visible === 1) {
        visible.add(course.id);
      } else {
        hiddenCourseCount += 1;
      }
    }
    if (visible.size > MAX_AUTHORIZED_COURSES) {
      // Truncating would silently drop access; refusing is visible and safe.
      throw new AuthorizationUnavailableError('invalid_moodle_response');
    }
    return { courseIds: [...visible].sort((a, b) => a - b), hiddenCourseCount };
  }
}
