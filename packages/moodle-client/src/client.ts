import type { z } from 'zod';

import { MoodleValidationError } from './errors.js';
import type { MoodleParams } from './params.js';
import {
  courseContentsSchema,
  coursesSchema,
  enrolledUsersSchema,
  siteInfoSchema,
  userCoursesSchema,
  usersSchema,
  type MoodleCourse,
  type MoodleCourseSection,
  type MoodleEnrolledUser,
  type MoodleSiteInfo,
  type MoodleUser,
  type MoodleUserCourse,
} from './schemas.js';
import type { MoodleCallOptions, MoodleFunctionName, MoodleTransport } from './transport.js';

export const USER_LOOKUP_FIELDS = ['id', 'idnumber', 'username', 'email'] as const;
export type MoodleUserLookupField = (typeof USER_LOOKUP_FIELDS)[number];

export interface GetCourseContentsOptions extends MoodleCallOptions {
  /** Omit file and content details, returning only sections and modules. */
  readonly excludeContents?: boolean;
}

export interface GetEnrolledUsersOptions extends MoodleCallOptions {
  readonly onlyActive?: boolean;
  readonly limitFrom?: number;
  readonly limitNumber?: number;
}

export interface MoodleClient {
  getSiteInfo(options?: MoodleCallOptions): Promise<MoodleSiteInfo>;
  /** All visible courses, or only `ids` when given. */
  getCourses(ids?: readonly number[], options?: MoodleCallOptions): Promise<MoodleCourse[]>;
  getCourseContents(
    courseId: number,
    options?: GetCourseContentsOptions,
  ): Promise<MoodleCourseSection[]>;
  getEnrolledUsers(
    courseId: number,
    options?: GetEnrolledUsersOptions,
  ): Promise<MoodleEnrolledUser[]>;
  getUserCourses(userId: number, options?: MoodleCallOptions): Promise<MoodleUserCourse[]>;
  getUsersByField(
    field: MoodleUserLookupField,
    values: readonly string[],
    options?: MoodleCallOptions,
  ): Promise<MoodleUser[]>;
}

const MAX_IDS_PER_CALL = 500;
const MAX_LOOKUP_VALUES = 100;
const MAX_LOOKUP_VALUE_LENGTH = 255;
const MAX_PAGE_SIZE = 1000;

function requestError(message: string, functionName: MoodleFunctionName): MoodleValidationError {
  return new MoodleValidationError(message, { code: 'invalid_request', functionName });
}

function requireId(value: number, label: string, functionName: MoodleFunctionName): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw requestError(`${label} must be a positive integer.`, functionName);
  }
  return value;
}

/** Typed operations over a {@link MoodleTransport}, validating inputs and every response. */
export class DefaultMoodleClient implements MoodleClient {
  constructor(private readonly transport: MoodleTransport) {}

  async getSiteInfo(options: MoodleCallOptions = {}): Promise<MoodleSiteInfo> {
    return await this.#call('core_webservice_get_site_info', {}, siteInfoSchema, options);
  }

  async getCourses(
    ids?: readonly number[],
    options: MoodleCallOptions = {},
  ): Promise<MoodleCourse[]> {
    const fn = 'core_course_get_courses';
    if (ids === undefined) {
      return await this.#call(fn, {}, coursesSchema, options);
    }
    if (ids.length === 0 || ids.length > MAX_IDS_PER_CALL) {
      throw requestError(`Between 1 and ${String(MAX_IDS_PER_CALL)} course IDs are required.`, fn);
    }
    const validIds = ids.map((value) => requireId(value, 'Course ID', fn));
    return await this.#call(fn, { options: { ids: validIds } }, coursesSchema, options);
  }

  async getCourseContents(
    courseId: number,
    options: GetCourseContentsOptions = {},
  ): Promise<MoodleCourseSection[]> {
    const fn = 'core_course_get_contents';
    const params: MoodleParams = {
      courseid: requireId(courseId, 'Course ID', fn),
      ...(options.excludeContents === true
        ? { options: [{ name: 'excludecontents', value: true }] }
        : {}),
    };
    return await this.#call(fn, params, courseContentsSchema, options);
  }

  async getEnrolledUsers(
    courseId: number,
    options: GetEnrolledUsersOptions = {},
  ): Promise<MoodleEnrolledUser[]> {
    const fn = 'core_enrol_get_enrolled_users';
    const moodleOptions: { name: string; value: string | number | boolean }[] = [];
    if (options.onlyActive !== undefined) {
      moodleOptions.push({ name: 'onlyactive', value: options.onlyActive });
    }
    if (options.limitFrom !== undefined || options.limitNumber !== undefined) {
      const from = options.limitFrom ?? 0;
      const number = options.limitNumber ?? MAX_PAGE_SIZE;
      if (!Number.isSafeInteger(from) || from < 0) {
        throw requestError('limitFrom must be a non-negative integer.', fn);
      }
      if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_PAGE_SIZE) {
        throw requestError(`limitNumber must be between 1 and ${String(MAX_PAGE_SIZE)}.`, fn);
      }
      moodleOptions.push(
        { name: 'limitfrom', value: from },
        { name: 'limitnumber', value: number },
      );
    }
    const params: MoodleParams = {
      courseid: requireId(courseId, 'Course ID', fn),
      ...(moodleOptions.length > 0 ? { options: moodleOptions } : {}),
    };
    return await this.#call(fn, params, enrolledUsersSchema, options);
  }

  async getUserCourses(
    userId: number,
    options: MoodleCallOptions = {},
  ): Promise<MoodleUserCourse[]> {
    const fn = 'core_enrol_get_users_courses';
    // returnusercount=0 avoids a per-course participant count query on the Moodle side.
    return await this.#call(
      fn,
      { userid: requireId(userId, 'User ID', fn), returnusercount: false },
      userCoursesSchema,
      options,
    );
  }

  async getUsersByField(
    field: MoodleUserLookupField,
    values: readonly string[],
    options: MoodleCallOptions = {},
  ): Promise<MoodleUser[]> {
    const fn = 'core_user_get_users_by_field';
    if (!(USER_LOOKUP_FIELDS as readonly string[]).includes(field)) {
      throw requestError('Unsupported user lookup field.', fn);
    }
    if (values.length === 0 || values.length > MAX_LOOKUP_VALUES) {
      throw requestError(
        `Between 1 and ${String(MAX_LOOKUP_VALUES)} lookup values are required.`,
        fn,
      );
    }
    for (const value of values) {
      if (value.trim() === '' || value.length > MAX_LOOKUP_VALUE_LENGTH) {
        throw requestError('Lookup values must be non-empty and at most 255 characters.', fn);
      }
    }
    return await this.#call(fn, { field, values: [...values] }, usersSchema, options);
  }

  async #call<Schema extends z.ZodType>(
    functionName: MoodleFunctionName,
    params: MoodleParams,
    schema: Schema,
    options: MoodleCallOptions,
  ): Promise<z.output<Schema>> {
    const raw = await this.transport.call(functionName, params, options);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Issue paths only: messages and inputs could echo response data.
      const issuePaths = [
        ...new Set(
          parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
        ),
      ].slice(0, 20);
      throw new MoodleValidationError(
        `Moodle response for ${functionName} did not match the expected schema.`,
        { code: 'response_schema_mismatch', functionName, issuePaths },
      );
    }
    return parsed.data;
  }
}
