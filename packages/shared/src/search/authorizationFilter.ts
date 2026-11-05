import {
  buildCourseFilter,
  buildPrincipalFilter,
  buildTenantFilter,
  type SearchPrincipals,
} from './odata.js';

/** Who may see what: supplied by trusted server code, never by the client. */
export interface AuthorizationScope {
  readonly tenantId: string;
  /** Courses the caller is authorised for (Moodle enrolments). Must not be empty. */
  readonly authorizedCourseIds: readonly number[];
  /** A client's narrowing; every course must be in the authorised set. */
  readonly selectedCourseIds?: readonly number[];
  readonly principals?: SearchPrincipals;
}

export interface AuthorizationFilter {
  /** OData filter for the search request: tenant, active content, courses (and principals). */
  readonly filter: string;
  /** The only courses results may come from; the client verifies every hit against it. */
  readonly effectiveCourseIds: ReadonlySet<number>;
}

export type SearchScopeErrorCode = 'empty_scope' | 'course_not_authorized' | 'invalid_query';

/** The request cannot be run as asked. Thrown before any network traffic. */
export class SearchScopeError extends Error {
  readonly code: SearchScopeErrorCode;

  constructor(code: SearchScopeErrorCode, message: string) {
    super(message);
    this.name = 'SearchScopeError';
    this.code = code;
  }
}

/**
 * The one place the security part of a search filter is built. The course list comes only from
 * the authorised set; a selected course outside it is refused rather than dropped, so a client
 * cannot learn anything by asking for someone else's course. Values go through the validating
 * OData builders, so no input can change the filter's structure.
 */
export class SearchAuthorizationFilterBuilder {
  build(scope: AuthorizationScope): AuthorizationFilter {
    if (scope.authorizedCourseIds.length === 0) {
      throw new SearchScopeError('empty_scope', 'No authorised courses: the search was not run.');
    }
    const authorized = new Set(scope.authorizedCourseIds);
    let effective = authorized;
    if (scope.selectedCourseIds !== undefined) {
      if (scope.selectedCourseIds.length === 0) {
        throw new SearchScopeError('invalid_query', 'An empty course selection was given.');
      }
      if (scope.selectedCourseIds.some((id) => !authorized.has(id))) {
        throw new SearchScopeError(
          'course_not_authorized',
          'A requested course is not in the authorised set.',
        );
      }
      effective = new Set(scope.selectedCourseIds);
    }
    const parts = [buildTenantFilter(scope.tenantId), buildCourseFilter([...effective])];
    if (scope.principals !== undefined) {
      parts.push(buildPrincipalFilter(scope.principals));
    }
    return { filter: parts.join(' and '), effectiveCourseIds: effective };
  }
}
