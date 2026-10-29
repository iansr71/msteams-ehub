import { createLogger, type Logger } from '@ehub/shared';
import type { EmbeddingProvider } from '@ehub/shared/embeddings';
import type { SearchCallOptions, SearchHit, SearchIndexClient } from '@ehub/shared/search';

import { RetrievalResultMapper, type RetrievedChunk } from './retrievalResultMapper.js';
import {
  RetrievalRequestError,
  SearchQueryBuilder,
  retrievalRequestSchema,
  type RetrievalMode,
  type RetrievalRequest,
} from './searchQueryBuilder.js';
import type { RetrievalSettings } from './settings.js';

export { RetrievalRequestError };

/** Embeds questions for vector and hybrid retrieval. */
export type QueryEmbedder = Pick<EmbeddingProvider, 'embedText' | 'getModelIdentifier'>;

export interface RetrievalResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly mode: RetrievalMode;
  readonly semanticApplied: boolean;
  readonly topK: number;
  /** The embedding model used for the question, when one was embedded. */
  readonly queryEmbeddingModel: string | undefined;
  /** Results the index returned before thresholds and the per-resource cap. */
  readonly candidates: number;
  readonly droppedBelowThreshold: number;
  readonly droppedByResourceCap: number;
  readonly durationMs: number;
}

/** The only search operation retrieval needs; lets tests and later phases substitute it. */
export type SearchPort = Pick<SearchIndexClient, 'search'>;

export interface RetrievalServiceOptions {
  readonly search: SearchPort;
  readonly settings: RetrievalSettings;
  /** When set, questions are embedded and retrieval defaults to hybrid. */
  readonly embedder?: QueryEmbedder;
  readonly logger?: Logger;
}

const silentLogger = createLogger({ service: 'retrieval', level: 'silent' });

/**
 * Runs filtered retrieval: validates the request, searches with every restriction inside the
 * search request, then applies score thresholds and the per-resource cap and keeps the top K.
 */
export class RetrievalService {
  readonly #search: SearchPort;
  readonly #settings: RetrievalSettings;
  readonly #builder: SearchQueryBuilder;
  readonly #mapper = new RetrievalResultMapper();
  readonly #logger: Logger;
  readonly #embedder: QueryEmbedder | undefined;

  constructor(options: RetrievalServiceOptions) {
    this.#search = options.search;
    this.#embedder = options.embedder;
    this.#settings = options.settings;
    this.#builder = new SearchQueryBuilder(options.settings);
    this.#logger = (options.logger ?? silentLogger).child({ component: 'retrieval' });
  }

  async retrieve(
    request: RetrievalRequest,
    options: SearchCallOptions = {},
  ): Promise<RetrievalResult> {
    const started = Date.now();
    const parsed = retrievalRequestSchema.safeParse(request);
    if (!parsed.success) {
      // Field names only: issues can quote the question.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      throw new RetrievalRequestError(
        fields,
        `Invalid retrieval request (${fields.join(', ') || 'request'}): ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    let validated = parsed.data;
    const mode =
      validated.mode ??
      (validated.queryVector !== undefined || this.#embedder !== undefined ? 'hybrid' : 'keyword');
    let queryEmbeddingModel: string | undefined;
    if (mode !== 'keyword' && validated.queryVector === undefined && this.#embedder !== undefined) {
      const embedding = await this.#embedder.embedText(validated.question, options);
      validated = { ...validated, queryVector: [...embedding.vector] };
      queryEmbeddingModel = embedding.metadata.modelIdentifier;
    }
    const built = this.#builder.build({ ...validated, mode });
    const response = await this.#search.search(built.query, options);

    const passing = response.hits.filter((hit) => this.#meetsThresholds(hit));
    const perResource = new Map<string, number>();
    const kept: SearchHit[] = [];
    let droppedByResourceCap = 0;
    for (const hit of passing) {
      const key = `${String(hit.document.courseId)}\u0000${hit.document.resourceId}`;
      const count = perResource.get(key) ?? 0;
      if (count >= this.#settings.maxChunksPerResource) {
        droppedByResourceCap += 1;
        continue;
      }
      perResource.set(key, count + 1);
      kept.push(hit);
    }
    const chunks = kept.slice(0, built.topK).map((hit, index) => this.#mapper.map(hit, index + 1));
    const result: RetrievalResult = {
      chunks,
      mode: built.mode,
      semanticApplied: response.semanticApplied,
      topK: built.topK,
      queryEmbeddingModel,
      candidates: response.hits.length,
      droppedBelowThreshold: response.hits.length - passing.length,
      droppedByResourceCap,
      durationMs: Date.now() - started,
    };
    // Counts and IDs only: no question text, no content.
    this.#logger.info('Retrieval completed.', {
      mode: result.mode,
      semanticApplied: result.semanticApplied,
      candidates: result.candidates,
      returned: chunks.length,
      droppedBelowThreshold: result.droppedBelowThreshold,
      droppedByResourceCap,
      courses: validated.courseIds?.length ?? validated.authorizedCourseIds.length,
      durationMs: result.durationMs,
    });
    return result;
  }

  #meetsThresholds(hit: SearchHit): boolean {
    const { minScore, minRerankerScore } = this.#settings;
    if (minScore !== undefined && hit.score < minScore) {
      return false;
    }
    return !(
      minRerankerScore !== undefined &&
      hit.rerankerScore !== undefined &&
      hit.rerankerScore < minRerankerScore
    );
  }
}
