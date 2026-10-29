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
    super('A principal restriction must name at least one user or group.');
    this.name = 'MissingPrincipalsError';
  }
}

/** `allowedUserIds/any(...) or allowedGroupIds/any(...)`; throws when both lists are empty. */
export function buildPrincipalFilter(principals: SearchPrincipals): string {
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
  return `(${clauses.join(' or ')})`;
}

export const MAX_FILTER_COURSES = 1000;

function courseIdLiteral(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidFilterValueError('course ID');
  }
  return String(value);
}

/**
 * `(courseId eq 1 or courseId eq 2)`. search.in only applies to string fields, so integer
 * course IDs are combined with `or`.
 */
export function buildCourseFilter(courseIds: readonly number[]): string {
  if (courseIds.length === 0 || courseIds.length > MAX_FILTER_COURSES) {
    throw new InvalidFilterValueError('course list');
  }
  const unique = [...new Set(courseIds.map(courseIdLiteral))];
  return `(${unique.map((id) => `courseId eq ${id}`).join(' or ')})`;
}

/** `search.in(field, 'a,b', ',')` over values already checked against an allow-list. */
export function buildStringInFilter(
  field: 'resourceType',
  values: readonly string[],
  allowed: ReadonlySet<string>,
): string {
  if (values.length === 0) {
    throw new InvalidFilterValueError(field);
  }
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new InvalidFilterValueError(field);
    }
  }
  return `search.in(${field}, ${odataString([...new Set(values)].join(','))}, ',')`;
}

/** Every query's base restriction: one tenant and active chunks only. */
export function buildTenantFilter(tenantId: string): string {
  return `tenantId eq ${odataString(assertIdentifier(tenantId, 'tenant ID'))} and isActive eq true`;
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
