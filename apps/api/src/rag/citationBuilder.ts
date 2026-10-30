import { redactString, sanitizeText } from '@ehub/shared';

import type { RetrievedChunk } from '../retrieval/retrievalResultMapper.js';
import { approvedSourceUrl, type CitationScope } from './citationValidator.js';

/** A displayed citation. Every field comes from retrieval metadata, never from model output. */
export interface Citation {
  /** 1-based, in order of first use in the answer's claims. */
  readonly citationId: number;
  readonly chunkId: string;
  readonly courseId: number;
  readonly courseName: string;
  readonly sectionName: string;
  /** The Moodle activity (course module) ID. */
  readonly moduleId: number;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly resourceType: string;
  readonly pageNumber: number | undefined;
  readonly pageNumberEnd: number | undefined;
  readonly slideNumber: number | undefined;
  /** Only for approved hosts; undefined otherwise. */
  readonly sourceUrl: string | undefined;
  /** A short, sanitised excerpt from this chunk (an authorised chunk). */
  readonly excerpt: string;
}

export interface CitedClaimInput {
  readonly text: string;
  readonly chunks: readonly RetrievedChunk[];
}

export interface BuiltCitations {
  readonly citations: readonly Citation[];
  /** For each input claim, the citation IDs it references, ascending. */
  readonly claimCitationIds: readonly (readonly number[])[];
}

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/**
 * The sentence of the chunk that best matches the claims citing it (most shared words; the
 * first sentence on a tie), cleaned and cut to `maxChars`.
 */
export function selectExcerpt(
  content: string,
  claims: readonly string[],
  maxChars: number,
): string {
  const target = words(claims.join(' '));
  let best = '';
  let bestScore = -1;
  for (const { segment } of segmenter.segment(content)) {
    const sentence = segment.trim();
    if (sentence === '') {
      continue;
    }
    let score = 0;
    for (const word of words(sentence)) {
      if (target.has(word)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return sanitizeText(redactString(best === '' ? content : best), maxChars);
}

/**
 * Deterministic numbering: citations are numbered in order of first reference, walking claims
 * in order and each claim's chunks in the order cited. A chunk cited by several claims is one
 * citation.
 */
export class CitationBuilder {
  readonly #excerptChars: number;

  constructor(excerptChars: number) {
    this.#excerptChars = excerptChars;
  }

  build(claims: readonly CitedClaimInput[], scope: CitationScope): BuiltCitations {
    const idByChunk = new Map<string, number>();
    const ordered: RetrievedChunk[] = [];
    const claimsByChunk = new Map<string, string[]>();
    const claimCitationIds = claims.map((claim) => {
      const ids = claim.chunks.map((chunk) => {
        let id = idByChunk.get(chunk.chunkId);
        if (id === undefined) {
          id = ordered.length + 1;
          idByChunk.set(chunk.chunkId, id);
          ordered.push(chunk);
        }
        claimsByChunk.set(chunk.chunkId, [...(claimsByChunk.get(chunk.chunkId) ?? []), claim.text]);
        return id;
      });
      return [...new Set(ids)].sort((a, b) => a - b);
    });
    const citations = ordered.map((chunk, index): Citation => ({
      citationId: index + 1,
      chunkId: chunk.chunkId,
      courseId: chunk.courseId,
      courseName: chunk.courseName,
      sectionName: chunk.sectionName,
      moduleId: chunk.moduleId,
      resourceId: chunk.resourceId,
      resourceName: chunk.resourceName,
      resourceType: chunk.resourceType,
      pageNumber: chunk.pageNumber,
      pageNumberEnd: chunk.pageNumberEnd,
      slideNumber: chunk.slideNumber,
      sourceUrl: approvedSourceUrl(chunk, scope.allowedHosts),
      excerpt: selectExcerpt(
        chunk.content,
        claimsByChunk.get(chunk.chunkId) ?? [],
        this.#excerptChars,
      ),
    }));
    return { citations, claimCitationIds };
  }
}
