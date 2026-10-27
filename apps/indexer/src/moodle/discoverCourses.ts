import type { MoodleCallOptions, MoodleClient, NormalizedMoodleBaseUrl } from '@ehub/moodle-client';

import { isSiteCourse, mapCourse } from './courseContentsMapper.js';
import type { CourseSummary } from './models.js';

export interface CourseFilter {
  /** Restrict to these course IDs (resolved by Moodle). */
  readonly courseIds?: readonly number[];
  /** Case-insensitive match against full name, short name, display name or ID number. */
  readonly search?: string;
}

export interface CourseDiscoveryResult {
  /** Matching courses, ordered by course ID. */
  readonly courses: readonly CourseSummary[];
  /** Courses Moodle returned before text filtering (site front page excluded). */
  readonly returnedByMoodle: number;
  /** Whether Moodle's front-page "site course" was dropped from the results. */
  readonly siteCourseExcluded: boolean;
}

function normalizeForSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en');
}

export function matchesSearch(course: CourseSummary, search: string): boolean {
  const needle = normalizeForSearch(search.trim());
  if (needle === '') {
    return true;
  }
  return [course.fullName, course.shortName, course.displayName, course.idNumber].some(
    (field) => field !== undefined && normalizeForSearch(field).includes(needle),
  );
}

export async function discoverCourses(
  client: MoodleClient,
  baseUrl: NormalizedMoodleBaseUrl,
  filter: CourseFilter = {},
  options: MoodleCallOptions = {},
): Promise<CourseDiscoveryResult> {
  const raw =
    filter.courseIds === undefined || filter.courseIds.length === 0
      ? await client.getCourses(undefined, options)
      : await client.getCourses([...new Set(filter.courseIds)], options);

  const mapped = raw.map((course) => mapCourse(course, baseUrl));
  const withoutSite = mapped.filter((course) => !isSiteCourse(course));
  const search = filter.search;
  const courses = (
    search === undefined
      ? withoutSite
      : withoutSite.filter((course) => matchesSearch(course, search))
  )
    .slice()
    .sort((a, b) => a.id - b.id);

  return {
    courses,
    returnedByMoodle: withoutSite.length,
    siteCourseExcluded: withoutSite.length !== mapped.length,
  };
}
