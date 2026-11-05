import {
  MoodleTransportError,
  MoodleValidationError,
  type MoodleUser,
  type MoodleUserCourse,
  type MoodleUserLookupField,
} from '@ehub/moodle-client';
import { createLogger, type Logger } from '@ehub/shared';

import type { AuthenticatedCaller } from '../../http/authentication.js';
import { userIdentitySchema } from '../../auth/userIdentity.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const COURSE_A = 101;
export const COURSE_B = 202;

export interface FakeMoodleUser extends MoodleUser {
  readonly courses?: readonly { readonly id: number; readonly visible?: 0 | 1 }[];
}

/**
 * Moodle as the identity code sees it: lookups match exactly like SQL `IN` (case-sensitive by
 * default, as on PostgreSQL), and failures can be switched on.
 */
export class FakeMoodle {
  users: FakeMoodleUser[] = [];
  caseInsensitive = false;
  failLookups = false;
  failCourses = false;
  lookups: { field: MoodleUserLookupField; values: readonly string[] }[] = [];
  courseCalls: number[] = [];

  getUsersByField(field: MoodleUserLookupField, values: readonly string[]): Promise<MoodleUser[]> {
    this.lookups.push({ field, values });
    if (this.failLookups) {
      return Promise.reject(
        new MoodleTransportError('Moodle unreachable.', { code: 'timeout', retryable: true }),
      );
    }
    if (field === 'email' && values.some((value) => value.startsWith('rejected'))) {
      return Promise.reject(
        new MoodleValidationError('Moodle exception (invalidparameter): Invalid parameter', {
          code: 'invalidparameter',
          moodleErrorCode: 'invalidparameter',
        }),
      );
    }
    const normalise = (value: string) => (this.caseInsensitive ? value.toLowerCase() : value);
    const wanted = new Set(values.map(normalise));
    const found = this.users.filter((user) => {
      const value =
        field === 'id' ? String(user.id) : field === 'email' ? user.email : user.username;
      return value !== undefined && wanted.has(normalise(value));
    });
    return Promise.resolve(
      found.map((user) => {
        const copy: FakeMoodleUser = { ...user };
        Reflect.deleteProperty(copy, 'courses');
        return copy;
      }),
    );
  }

  /** Replaces one account's enrolments (e.g. to revoke them). */
  setCourses(userId: number, courses: FakeMoodleUser['courses']): void {
    this.users = this.users.map((user) =>
      user.id === userId ? { ...user, ...(courses === undefined ? {} : { courses }) } : user,
    );
  }

  getUserCourses(userId: number): Promise<MoodleUserCourse[]> {
    this.courseCalls.push(userId);
    if (this.failCourses) {
      return Promise.reject(
        new MoodleTransportError('Moodle unreachable.', { code: 'timeout', retryable: true }),
      );
    }
    const user = this.users.find((entry) => entry.id === userId);
    return Promise.resolve(
      (user?.courses ?? []).map((course) => ({
        id: course.id,
        shortname: `C${String(course.id)}`,
        fullname: `Course ${String(course.id)}`,
        ...(course.visible === undefined ? {} : { visible: course.visible }),
      })),
    );
  }
}

export function moodleUser(id: number, overrides: Partial<FakeMoodleUser> = {}): FakeMoodleUser {
  return {
    id,
    username: `user${String(id)}`,
    fullname: `User ${String(id)}`,
    email: `user${String(id)}@example.test`,
    suspended: false,
    ...overrides,
  };
}

export function caller(
  objectId: string,
  claims: {
    email?: string;
    emailAsIssued?: string;
    upn?: string;
    upnSource?: 'upn' | 'preferred_username';
    accountType?: 'member' | 'guest';
  } = {},
): AuthenticatedCaller {
  return {
    mock: false,
    identity: userIdentitySchema.parse({
      tenantId: TENANT,
      objectId,
      ...(claims.email === undefined
        ? {}
        : { email: claims.email, emailAsIssued: claims.emailAsIssued ?? claims.email }),
      ...(claims.upn === undefined
        ? {}
        : { userPrincipalName: claims.upn, userPrincipalNameSource: claims.upnSource ?? 'upn' }),
      roles: [],
      authentication: {
        method: 'entra-access-token',
        scopes: ['access_as_user'],
        ...(claims.accountType === undefined ? {} : { accountType: claims.accountType }),
      },
    }),
  };
}

export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => lines.push(line) },
    }),
  };
}
