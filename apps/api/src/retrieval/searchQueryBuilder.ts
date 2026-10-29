import {
  MAX_QUERY_TEXT_CHARS,
  MAX_SEARCH_TOP,
  SEARCH_RESOURCE_TYPES,
  type SearchQuery,
  type SearchResourceType,
} from '@ehub/shared/search';
import { replaceUnsafeCharacters } from '@ehub/shared';
import { z } from 'zod';

import type { RetrievalSettings } from './settings.js';

export const RETRIEVAL_MODES = ['keyword', 'vector', 'hybrid'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

const courseId = z.number().int().positive().max(2_147_483_647);
/** What a caller asks for. Authorisation (tenant and courses) is supplied by trusted code. */
export const retrievalRequestSchema = z
  .strictObject({
    question: z
      .string()
      .transform((value) => replaceUnsafeCharacters(value).replace(/\s+/g, ' ').trim())
      .pipe(z.string().min(1, { message: 'must not be empty.' }).max(MAX_QUERY_TEXT_CHARS)),
    tenantId: z.string().min(1),
    authorizedCourseIds: z.array(courseId).min(1, { message: 'no authorised courses.' }).max(1000),
    courseIds: z.array(courseId).min(1).max(1000).optional(),
    resourceTypes: z.array(z.enum(SEARCH_RESOURCE_TYPES)).min(1).optional(),
    queryVector: z.array(z.number()).min(1).optional(),
    mode: z.enum(RETRIEVAL_MODES).optional(),
    topK: z.number().int().min(1).max(MAX_SEARCH_TOP).optional(),
  })
  .superRefine((request, ctx) => {
    const mode = request.mode ?? (request.queryVector === undefined ? 'keyword' : 'hybrid');
    if (mode !== 'keyword' && request.queryVector === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['queryVector'],
        message: `${mode} retrieval needs a query vector.`,
      });
    }
  });
export type RetrievalRequest = z.input<typeof retrievalRequestSchema>;
export type ValidatedRetrievalRequest = z.output<typeof retrievalRequestSchema>;

export interface BuiltSearchQuery {
  readonly query: SearchQuery;
  readonly mode: RetrievalMode;
  readonly topK: number;
}

/**
 * Turns a validated request and the retrieval settings into the search client's query. The
 * client builds the filter from it (tenant, active content, courses, resource types), so every
 * restriction is part of the search request itself.
 */
export class SearchQueryBuilder {
  readonly #settings: RetrievalSettings;

  constructor(settings: RetrievalSettings) {
    this.#settings = settings;
  }

  build(request: ValidatedRetrievalRequest): BuiltSearchQuery {
    const mode: RetrievalMode =
      request.mode ?? (request.queryVector === undefined ? 'keyword' : 'hybrid');
    const topK = request.topK ?? this.#settings.topK;
    // Fetch extra candidates so the per-resource cap and thresholds can still fill top K.
    const candidates = Math.min(MAX_SEARCH_TOP, Math.max(this.#settings.candidateCount, topK));
    const resourceTypes: readonly SearchResourceType[] | undefined = request.resourceTypes;
    const query: SearchQuery = {
      tenantId: request.tenantId,
      authorizedCourseIds: request.authorizedCourseIds,
      ...(request.courseIds === undefined ? {} : { courseIds: request.courseIds }),
      ...(resourceTypes === undefined ? {} : { resourceTypes }),
      ...(mode === 'vector' ? {} : { text: request.question }),
      ...(mode === 'keyword' || request.queryVector === undefined
        ? {}
        : { vector: request.queryVector, vectorK: candidates }),
      top: candidates,
      semantic: this.#settings.semanticRanking,
    };
    return { query, mode, topK };
  }
}
