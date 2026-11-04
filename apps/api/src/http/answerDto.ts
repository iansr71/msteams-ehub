import { answerResponseSchema, type AnswerResponse } from '@ehub/shared/answers';

import type { RagAnswer } from '../rag/ragService.js';

const MAX_WARNING_CHARS = 80;

/**
 * The public answer: text, claims, validated citations and warning codes. Retrieval
 * internals (chunk IDs, passages given to the model, scores, model name) are not exposed.
 */
export function toAnswerResponse(
  answer: RagAnswer,
  answerId: string,
  mockIdentity: boolean,
): AnswerResponse {
  return answerResponseSchema.parse({
    answerId,
    status: answer.status,
    answer: answer.answer,
    claims: answer.claims.map((claim) => ({
      text: claim.text,
      citationIds: [...claim.citationIds],
    })),
    citations: answer.citations.map((citation) => ({
      citationId: citation.citationId,
      courseId: citation.courseId,
      courseName: citation.courseName,
      sectionName: citation.sectionName,
      moduleId: citation.moduleId,
      resourceName: citation.resourceName,
      resourceType: citation.resourceType,
      ...(citation.pageNumber === undefined ? {} : { pageNumber: citation.pageNumber }),
      ...(citation.pageNumberEnd === undefined ? {} : { pageNumberEnd: citation.pageNumberEnd }),
      ...(citation.slideNumber === undefined ? {} : { slideNumber: citation.slideNumber }),
      ...(citation.sourceUrl === undefined ? {} : { sourceUrl: citation.sourceUrl }),
      excerpt: citation.excerpt,
    })),
    conflictingSources: answer.conflictingSources,
    warnings: [...new Set(answer.warnings)]
      .map((warning) => warning.slice(0, MAX_WARNING_CHARS))
      .slice(0, 30),
    mockIdentity,
  });
}
