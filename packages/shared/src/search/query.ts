import {
  RETRIEVABLE_FIELD_NAMES,
  SEMANTIC_CONFIGURATION_NAME,
  VECTOR_FIELD_NAME,
} from './indexDefinition.js';
import { SearchAuthorizationFilterBuilder, SearchScopeError } from './authorizationFilter.js';
import { buildStringInFilter, type SearchPrincipals } from './odata.js';

export { SearchScopeError, type SearchScopeErrorCode } from './authorizationFilter.js';

/*
 * Turns a search request into the REST body. Pure, so tests can check exactly what is sent.
 * Every restriction (tenant, active content, authorised courses, optional principals and
 * resource types) is placed in the `filter`, which Azure applies inside the query; nothing
 * depends on filtering results afterwards.
 */

/** Resource types the extractors produce; the only values a resource-type filter accepts. */
export const SEARCH_RESOURCE_TYPES = [
  'pdf',
  'docx',
  'pptx',
  'html',
  'plain-text',
  'moodle-page',
  'moodle-book-chapter',
] as const;
export type SearchResourceType = (typeof SEARCH_RESOURCE_TYPES)[number];
const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(SEARCH_RESOURCE_TYPES);

export const MAX_SEARCH_TOP = 50;
export const MAX_QUERY_TEXT_CHARS = 1000;

export interface SearchQuery {
  readonly tenantId: string;
  /**
   * Courses the caller is authorised to read (from Moodle enrolments). Required and
   * non-empty: a search can never be unscoped.
   */
  readonly authorizedCourseIds: readonly number[];
  /** Optional narrowing to some authorised courses; any course outside the set is refused. */
  readonly courseIds?: readonly number[];
  /** Optional extra restriction to chunks listing one of these users or groups. */
  readonly principals?: SearchPrincipals;
  readonly resourceTypes?: readonly SearchResourceType[];
  /** Keyword/semantic query text. At least one of `text` and `vector` is required. */
  readonly text?: string;
  /** Query embedding for vector similarity; must have the index's dimensions. */
  readonly vector?: readonly number[];
  /** Results to return (1-50). Default 5. */
  readonly top?: number;
  /** Nearest neighbours the vector part considers. Default `top`; at most 50. */
  readonly vectorK?: number;
  /** Use semantic ranking when the index has it and `text` is given. Default true. */
  readonly semantic?: boolean;
}

export interface SearchRequestPlan {
  readonly body: Readonly<Record<string, unknown>>;
  readonly filter: string;
  /** Courses results may come from; used to verify the response. */
  readonly effectiveCourseIds: ReadonlySet<number>;
  readonly semantic: boolean;
  readonly mode: 'keyword' | 'vector' | 'hybrid';
}

export interface SearchRequestOptions {
  readonly vectorDimensions: number;
  readonly semanticEnabled: boolean;
}

function boundedCount(value: number | undefined, fallback: number, what: string): number {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < 1 || count > MAX_SEARCH_TOP) {
    throw new SearchScopeError(
      'invalid_query',
      `${what} must be between 1 and ${String(MAX_SEARCH_TOP)}.`,
    );
  }
  return count;
}

const AUTHORIZATION_FILTER = new SearchAuthorizationFilterBuilder();

export function buildSearchRequest(
  query: SearchQuery,
  options: SearchRequestOptions,
): SearchRequestPlan {
  const authorization = AUTHORIZATION_FILTER.build({
    tenantId: query.tenantId,
    authorizedCourseIds: query.authorizedCourseIds,
    ...(query.courseIds === undefined ? {} : { selectedCourseIds: query.courseIds }),
    ...(query.principals === undefined ? {} : { principals: query.principals }),
  });
  const effective = authorization.effectiveCourseIds;
  const filters = [authorization.filter];
  if (query.resourceTypes !== undefined) {
    filters.push(buildStringInFilter('resourceType', query.resourceTypes, RESOURCE_TYPE_SET));
  }

  const top = boundedCount(query.top, 5, 'top');
  const text = query.text?.trim() ?? '';
  if (text.length > MAX_QUERY_TEXT_CHARS) {
    throw new SearchScopeError(
      'invalid_query',
      `Query text must be at most ${String(MAX_QUERY_TEXT_CHARS)} characters.`,
    );
  }
  if (text === '' && query.vector === undefined) {
    throw new SearchScopeError(
      'invalid_query',
      'A search needs query text, a query vector, or both.',
    );
  }
  if (
    query.vector !== undefined &&
    (query.vector.length !== options.vectorDimensions ||
      !query.vector.every((value) => Number.isFinite(value)))
  ) {
    throw new SearchScopeError(
      'invalid_query',
      'The query vector does not match the index dimensions.',
    );
  }
  const vectorK = boundedCount(query.vectorK, top, 'vectorK');
  const semantic = options.semanticEnabled && query.semantic !== false && text !== '';
  const filter = filters.join(' and ');

  const body: Record<string, unknown> = {
    // A vector-only query omits `search`: sending '*' would add a match-everything text leg to
    // the rank fusion and blur the vector ranking.
    ...(text === '' ? {} : { search: text }),
    filter,
    select: RETRIEVABLE_FIELD_NAMES.join(','),
    top,
    ...(semantic
      ? { queryType: 'semantic', semanticConfiguration: SEMANTIC_CONFIGURATION_NAME }
      : { queryType: 'simple' }),
    ...(query.vector === undefined
      ? {}
      : {
          vectorQueries: [
            { kind: 'vector', vector: [...query.vector], fields: VECTOR_FIELD_NAME, k: vectorK },
          ],
          // Filter before nearest-neighbour selection, so chunks outside the scope can never
          // displace authorised ones from the top k.
          vectorFilterMode: 'preFilter',
        }),
  };
  return {
    body,
    filter,
    effectiveCourseIds: effective,
    semantic,
    mode: query.vector === undefined ? 'keyword' : text === '' ? 'vector' : 'hybrid',
  };
}
