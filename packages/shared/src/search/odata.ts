import { SEARCH_IDENTIFIER_PATTERN } from './documents.js';

/*
 * Filter expressions are built here and nowhere else. Values are either validated integers,
 * validated identifiers, or string literals with quotes escaped, so text from Moodle or from a
 * user can never change the structure of a filter.
 */

export class InvalidFilterValueError extends Error {
  constructor(what: string) {
    super(`Invalid ${what} for a search filter.`);
    this.name = 'InvalidFilterValueError';
  }
}

/** An OData string literal: single quotes doubled, as the OData grammar requires. */
export function odataString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function odataInteger(value: number, what: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidFilterValueError(what);
  }
  return String(value);
}

export function assertIdentifier(value: string, what: string): string {
  if (!SEARCH_IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidFilterValueError(what);
  }
  return value;
}

/** `field/any(v: search.in(v, 'a,b', ','))`; identifiers cannot contain the comma delimiter. */
function anyIn(field: string, values: readonly string[], what: string): string {
  const list = values.map((value) => assertIdentifier(value, what)).join(',');
  return `${field}/any(v: search.in(v, ${odataString(list)}, ','))`;
}

export interface SearchPrincipals {
  /** IDs of the asking user (normally one). */
  readonly userIds: readonly string[];
  /** IDs of groups the asking user belongs to. */
  readonly groupIds: readonly string[];
}

export class MissingPrincipalsError extends Error {
  constructor() {
    super('A search must name at least one user or group principal.');
    this.name = 'MissingPrincipalsError';
  }
}

/**
 * Restricts results to one tenant, active chunks, and chunks that list one of the caller's
 * principals. Throws rather than returning an unrestricted filter when no principal is given.
 */
export function buildSecurityFilter(tenantId: string, principals: SearchPrincipals): string {
  const tenant = assertIdentifier(tenantId, 'tenant ID');
  const clauses: string[] = [];
  if (principals.userIds.length > 0) {
    clauses.push(anyIn('allowedUserIds', principals.userIds, 'user ID'));
  }
  if (principals.groupIds.length > 0) {
    clauses.push(anyIn('allowedGroupIds', principals.groupIds, 'group ID'));
  }
  if (clauses.length === 0) {
    throw new MissingPrincipalsError();
  }
  return `tenantId eq ${odataString(tenant)} and isActive eq true and (${clauses.join(' or ')})`;
}

export function buildCourseFilter(courseIds: readonly number[]): string {
  if (courseIds.length === 0) {
    throw new InvalidFilterValueError('course list');
  }
  return `(${courseIds.map((id) => `courseId eq ${odataInteger(id, 'course ID')}`).join(' or ')})`;
}

export interface DocumentScope {
  readonly tenantId: string;
  readonly courseId: number;
  readonly resourceId?: string;
}

/** Selects every chunk of one course, or of one resource within it. */
export function buildScopeFilter(scope: DocumentScope): string {
  const parts = [
    `tenantId eq ${odataString(assertIdentifier(scope.tenantId, 'tenant ID'))}`,
    `courseId eq ${odataInteger(scope.courseId, 'course ID')}`,
  ];
  if (scope.resourceId !== undefined) {
    if (scope.resourceId === '') {
      throw new InvalidFilterValueError('resource ID');
    }
    parts.push(`resourceId eq ${odataString(scope.resourceId)}`);
  }
  return parts.join(' and ');
}
