import type { SearchCallOptions } from '@ehub/shared/search';

import type { RetrievedChunk } from '../retrieval/retrievalResultMapper.js';
import type { RetrievalResult, RetrievalService } from '../retrieval/retrievalService.js';

export interface OrchestratedRetrievalRequest {
  readonly question: string;
  readonly tenantId: string;
  readonly authorizedCourseIds: readonly number[];
  readonly selectedCourseIds?: readonly number[];
}

export type SupportShortfall = 'too_few_chunks' | 'top_score_below_threshold' | 'no_reranker_score';

export type OrchestratedRetrieval =
  | {
      readonly status: 'supported';
      readonly chunks: readonly RetrievedChunk[];
      readonly retrieval: RetrievalResult;
    }
  | {
      readonly status: 'insufficient';
      readonly reason: SupportShortfall;
      readonly retrieval: RetrievalResult;
    };

export interface RetrievalOrchestratorOptions {
  readonly retrieval: Pick<RetrievalService, 'retrieve'>;
  readonly minSupportingChunks: number;
  /** When set, the best chunk's reranker score must reach it; no reranker score fails closed. */
  readonly minTopRerankerScore: number | undefined;
}

/**
 * Runs filtered hybrid retrieval (hybrid when the retrieval service has an embedder) and decides
 * whether the results are strong enough to attempt an answer at all.
 */
export class RetrievalOrchestrator {
  readonly #options: RetrievalOrchestratorOptions;

  constructor(options: RetrievalOrchestratorOptions) {
    this.#options = options;
  }

  async retrieve(
    request: OrchestratedRetrievalRequest,
    options: SearchCallOptions = {},
  ): Promise<OrchestratedRetrieval> {
    const retrieval = await this.#options.retrieval.retrieve(
      {
        question: request.question,
        tenantId: request.tenantId,
        authorizedCourseIds: [...request.authorizedCourseIds],
        ...(request.selectedCourseIds === undefined
          ? {}
          : { courseIds: [...request.selectedCourseIds] }),
      },
      options,
    );
    if (retrieval.chunks.length < this.#options.minSupportingChunks) {
      return { status: 'insufficient', reason: 'too_few_chunks', retrieval };
    }
    const threshold = this.#options.minTopRerankerScore;
    if (threshold !== undefined) {
      const best = Math.max(
        ...retrieval.chunks.map((chunk) => chunk.rerankerScore ?? Number.NEGATIVE_INFINITY),
      );
      if (best === Number.NEGATIVE_INFINITY) {
        return { status: 'insufficient', reason: 'no_reranker_score', retrieval };
      }
      if (best < threshold) {
        return { status: 'insufficient', reason: 'top_score_below_threshold', retrieval };
      }
    }
    return { status: 'supported', chunks: retrieval.chunks, retrieval };
  }
}
