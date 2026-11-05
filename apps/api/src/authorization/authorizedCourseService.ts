import { getTelemetry, type Logger, type TelemetrySpan } from '@ehub/shared';

import type { CourseAccessResolver } from '../auth/courseAccess.js';
import type { AuthenticatedCaller } from '../http/authentication.js';
import type { AuthorizationCache, CachedAuthorization } from './authorizationCache.js';
import { AuthorizationUnavailableError, IdentityNotMappedError } from './errors.js';
import type { EntraIdentityClaims, MoodleIdentityResolver } from './moodleIdentityResolver.js';
import type { MoodleEnrollmentService } from './moodleEnrollmentService.js';
import { userKeyString, type EntraUserKey } from './records.js';

export interface AuthorizedCourseServiceOptions {
  readonly resolver: Pick<MoodleIdentityResolver, 'resolve'>;
  readonly enrolments: Pick<MoodleEnrollmentService, 'coursesFor'>;
  readonly cache: AuthorizationCache;
  /** How long after expiry a cached grant may still be used while Moodle is unreachable. */
  readonly staleGraceMs: number;
  /** DEVELOPMENT ONLY: courses for the mock identity (ignored outside development). */
  readonly mockCourseIds?: readonly number[];
  readonly nodeEnv: string;
  readonly logger: Logger;
}

export function claimsOf(caller: AuthenticatedCaller): EntraIdentityClaims {
  const { identity } = caller;
  return {
    tenantId: identity.tenantId,
    objectId: identity.objectId,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.emailAsIssued === undefined ? {} : { emailAsIssued: identity.emailAsIssued }),
    ...(identity.userPrincipalName === undefined
      ? {}
      : { userPrincipalName: identity.userPrincipalName }),
    ...(identity.userPrincipalNameSource === undefined
      ? {}
      : { userPrincipalNameSource: identity.userPrincipalNameSource }),
    ...(identity.authentication.accountType === undefined
      ? {}
      : { accountType: identity.authentication.accountType }),
  };
}

/**
 * The courses a caller may ask about, decided before retrieval from Moodle: the validated Entra
 * identity is mapped to one Moodle account, and that account's active enrolments in visible
 * courses become the course filter applied inside the search request.
 *
 * Results are cached for the configured TTL. When Moodle cannot be reached the request is
 * refused, unless the stale-grace policy (off by default) allows a recently expired grant.
 */
export class AuthorizedCourseService implements CourseAccessResolver {
  readonly mode = 'moodle-enrolments';
  readonly #options: AuthorizedCourseServiceOptions;
  readonly #logger: Logger;
  readonly #inFlight = new Map<string, Promise<CachedAuthorization>>();
  readonly #mockCourseIds: readonly number[];

  constructor(options: AuthorizedCourseServiceOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'course-authorization' });
    this.#mockCourseIds =
      options.nodeEnv === 'development' ? [...(options.mockCourseIds ?? [])] : [];
  }

  async resolve(caller: AuthenticatedCaller): Promise<readonly number[]> {
    return await getTelemetry().span('authorization.courses', async (span) => {
      try {
        const courses = await this.#resolveCourses(caller, span);
        span.set({ 'ehub.count.courses': courses.length });
        return courses;
      } catch (error) {
        span.fail(
          error instanceof IdentityNotMappedError
            ? 'identity_not_mapped'
            : error instanceof AuthorizationUnavailableError
              ? error.reason
              : 'error',
        );
        throw error;
      }
    });
  }

  async #resolveCourses(
    caller: AuthenticatedCaller,
    span: TelemetrySpan,
  ): Promise<readonly number[]> {
    if (caller.mock) {
      return this.#mockCourseIds;
    }
    const claims = claimsOf(caller);
    const key: EntraUserKey = { tenantId: claims.tenantId, objectId: claims.objectId };
    const cached = await this.#options.cache.lookup(key);
    if (cached?.fresh === true) {
      span.set({ 'ehub.source': 'cache' });
      return this.#outcome(cached.value, 'cache');
    }
    let value: CachedAuthorization;
    try {
      value = await this.#load(key, claims);
    } catch (error) {
      if (!(error instanceof AuthorizationUnavailableError)) {
        throw error;
      }
      const stale = await this.#options.cache.lookup(key, {
        staleGraceMs: this.#options.staleGraceMs,
      });
      if (stale?.value.kind === 'authorized') {
        this.#logger.warn('Moodle unavailable; using a recently expired authorisation.', {
          reason: error.reason,
          ageMs: stale.ageMs,
        });
        span.set({ 'ehub.source': 'stale' });
        return this.#outcome(stale.value, 'stale');
      }
      this.#logger.error('Course authorisation could not be confirmed.', {
        reason: error.reason,
        causeType: error.causeType,
      });
      throw error;
    }
    span.set({ 'ehub.source': 'moodle' });
    return this.#outcome(value, 'moodle');
  }

  /** Drops this process's cached authorisation for a user (e.g. after a mapping change). */
  invalidate(key: EntraUserKey): void {
    this.#options.cache.invalidate(key);
  }

  /** Bypasses the cache: what Moodle says right now. For the admin commands. */
  async current(claims: EntraIdentityClaims): Promise<CachedAuthorization> {
    return await this.#fetch(claims, { audit: false });
  }

  #outcome(value: CachedAuthorization, source: 'cache' | 'stale' | 'moodle'): readonly number[] {
    if (value.kind === 'denied') {
      throw new IdentityNotMappedError(value.reason);
    }
    this.#logger.debug('Courses authorised.', { source, courses: value.courseIds.length });
    return value.courseIds;
  }

  async #load(key: EntraUserKey, claims: EntraIdentityClaims): Promise<CachedAuthorization> {
    const id = userKeyString(key);
    const running = this.#inFlight.get(id);
    if (running !== undefined) {
      return await running;
    }
    const task = (async () => {
      const value = await this.#fetch(claims, { audit: true });
      this.#options.cache.set(key, value);
      return value;
    })();
    this.#inFlight.set(id, task);
    try {
      return await task;
    } finally {
      this.#inFlight.delete(id);
    }
  }

  async #fetch(
    claims: EntraIdentityClaims,
    options: { readonly audit: boolean },
  ): Promise<CachedAuthorization> {
    const resolution = await this.#options.resolver.resolve(claims, options);
    if (resolution.status === 'denied') {
      return { kind: 'denied', reason: resolution.reason };
    }
    const enrolments = await this.#options.enrolments.coursesFor(resolution.moodleUserId);
    return {
      kind: 'authorized',
      moodleUserId: resolution.moodleUserId,
      method: resolution.method,
      courseIds: enrolments.courseIds,
    };
  }
}
