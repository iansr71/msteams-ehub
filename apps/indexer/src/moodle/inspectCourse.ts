import type { MoodleCallOptions, MoodleClient, NormalizedMoodleBaseUrl } from '@ehub/moodle-client';

import { isSiteCourse, mapCourse, mapCourseContents } from './courseContentsMapper.js';
import { summarizeCourseStructure, type CourseDiagnosticSummary } from './diagnosticOutput.js';
import type { CourseResource, CourseStructure } from './models.js';

export class CourseNotFoundError extends Error {
  readonly code = 'course_not_found';

  constructor(readonly courseId: number) {
    super(
      `Course ${String(courseId)} was not returned by Moodle. It may not exist, or the service account cannot see it.`,
    );
    this.name = 'CourseNotFoundError';
  }
}

export class ResourceNotFoundError extends Error {
  readonly code = 'resource_not_found';

  constructor(courseId: number) {
    // The resource ID is caller-supplied text; it is not echoed back.
    super(`The resource ID was not found in course ${String(courseId)}.`);
    this.name = 'ResourceNotFoundError';
  }
}

export function findCourseResource(structure: CourseStructure, resourceId: string): CourseResource {
  const resource = structure.resources.find((candidate) => candidate.resourceId === resourceId);
  if (resource === undefined) {
    throw new ResourceNotFoundError(structure.course.id);
  }
  return resource;
}

export interface InspectCourseOptions extends MoodleCallOptions {
  /** Report files larger than this as unsupported (use the configured download limit). */
  readonly maxFileBytes?: number;
}

export interface CourseInspection {
  readonly structure: CourseStructure;
  readonly summary: CourseDiagnosticSummary;
}

/**
 * Reads one course's structure and file metadata. No file content is downloaded or parsed.
 */
export async function inspectCourse(
  client: MoodleClient,
  baseUrl: NormalizedMoodleBaseUrl,
  courseId: number,
  options: InspectCourseOptions = {},
): Promise<CourseInspection> {
  const callOptions: MoodleCallOptions =
    options.signal === undefined ? {} : { signal: options.signal };
  const [course] = (await client.getCourses([courseId], callOptions)).filter(
    (candidate) => candidate.id === courseId && !isSiteCourse(candidate),
  );
  if (course === undefined) {
    throw new CourseNotFoundError(courseId);
  }

  const sections = await client.getCourseContents(courseId, callOptions);
  const structure = mapCourseContents(mapCourse(course, baseUrl), sections, {
    baseUrl,
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  });
  return { structure, summary: summarizeCourseStructure(structure) };
}
