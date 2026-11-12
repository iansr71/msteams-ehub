import { INSUFFICIENT_EVIDENCE_MESSAGE } from '../answerSchema.js';
import type { Citation } from '../citationBuilder.js';
import type { RagAnswer, RagSource } from '../ragService.js';

/*
 * Answers built by hand, in the real shapes, for tests that score or render an answer without
 * running the engine. Using the real types means a change to RagAnswer, Citation or RagSource
 * shows up here rather than being hidden behind a cast.
 */

export const FIXTURE_COURSE = 12;
export const FIXTURE_RESOURCE = '701:chapter:11';

export function fixtureCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    citationId: 1,
    chunkId: 'chunk-1',
    courseId: FIXTURE_COURSE,
    courseName: 'Chemical peels',
    sectionName: 'Aftercare',
    moduleId: 701,
    resourceId: FIXTURE_RESOURCE,
    resourceName: 'Aftercare checklist',
    resourceType: 'moodle-book-chapter',
    pageNumber: undefined,
    pageNumberEnd: undefined,
    slideNumber: undefined,
    sourceUrl: undefined,
    excerpt: 'Reapply sunscreen every two hours.',
    ...overrides,
  };
}

/** The retrieved chunk a citation refers to, so citations map to sources as in production. */
export function fixtureSource(citation: Citation, overrides: Partial<RagSource> = {}): RagSource {
  return {
    chunkId: citation.chunkId,
    courseId: citation.courseId,
    courseName: citation.courseName,
    sectionName: citation.sectionName,
    moduleId: citation.moduleId,
    resourceId: citation.resourceId,
    resourceName: citation.resourceName,
    resourceType: citation.resourceType,
    title: citation.resourceName,
    headingPath: [],
    pageNumber: undefined,
    pageNumberEnd: undefined,
    slideNumber: undefined,
    sourceUrl: undefined,
    moduleUrl: undefined,
    rank: 1,
    ...overrides,
  };
}

/**
 * A grounded answer: one claim, one citation, and the matching source. Overrides are applied
 * last; pass `sources` explicitly to break the citation-to-source mapping deliberately.
 */
export function fixtureAnswer(overrides: Partial<RagAnswer> = {}): RagAnswer {
  const citations = overrides.citations ?? [fixtureCitation()];
  return {
    status: 'answered',
    answer: 'Reapply sunscreen every two hours after a peel.',
    claims: [
      {
        text: 'Reapply sunscreen every two hours after a peel.',
        citationIds: [1],
        chunkIds: ['chunk-1'],
      },
    ],
    citations,
    removedClaims: 0,
    insufficientEvidence: false,
    conflictingSources: false,
    warnings: [],
    modelWarnings: [],
    sources: citations.map((citation) => fixtureSource(citation)),
    model: 'fixture-model',
    generationAttempts: 1,
    durationMs: 1,
    ...overrides,
  };
}

/** The fixed insufficient-evidence answer, exactly as the engine returns it. */
export function fixtureInsufficientAnswer(): RagAnswer {
  return fixtureAnswer({
    status: 'insufficient_evidence',
    answer: INSUFFICIENT_EVIDENCE_MESSAGE,
    claims: [],
    citations: [],
    sources: [],
    insufficientEvidence: true,
  });
}
