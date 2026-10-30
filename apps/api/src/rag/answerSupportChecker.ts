import { sanitizeText } from '@ehub/shared';

import { INSUFFICIENT_EVIDENCE_MESSAGE, type ModelAnswer } from './answerSchema.js';
import type { PromptSource } from './promptBuilder.js';

export type SupportWarning =
  'conflicting_sources' | 'claim_without_source' | 'no_supported_claims' | 'unverified_url_removed';

export interface SupportedClaim {
  readonly text: string;
  /** Chunk IDs of the retrieved chunks the claim cites. */
  readonly chunkIds: readonly string[];
}

export interface CheckedAnswer {
  readonly insufficientEvidence: boolean;
  readonly answer: string;
  readonly claims: readonly SupportedClaim[];
  readonly conflictingSources: boolean;
  readonly warnings: readonly SupportWarning[];
  /** The model's own warnings, sanitised and bounded. */
  readonly modelWarnings: readonly string[];
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/**
 * Structural support checks on a valid model answer before it is returned. Phase 10 adds full
 * citation validation; this layer refuses answers whose claims are not tied to provided sources
 * and removes URLs that no source contains.
 */
export class AnswerSupportChecker {
  check(answer: ModelAnswer, sources: readonly PromptSource[]): CheckedAnswer {
    const modelWarnings = answer.warnings
      .map((warning) => sanitizeText(warning, 200))
      .filter((warning) => warning !== '-');
    const insufficient = (warnings: SupportWarning[]): CheckedAnswer => ({
      insufficientEvidence: true,
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      claims: [],
      conflictingSources: false,
      warnings,
      modelWarnings,
    });

    if (answer.insufficientEvidence) {
      return insufficient([]);
    }
    if (answer.claims.length === 0 || answer.answer.trim() === '') {
      return insufficient(['no_supported_claims']);
    }
    if (answer.claims.some((claim) => claim.sourceIds.length === 0)) {
      // An answer with an unsupported material claim is not returned at all.
      return insufficient(['claim_without_source']);
    }

    const bySourceId = new Map(sources.map((source) => [source.sourceId, source.chunk]));
    const knownUrls = new Set(
      sources.flatMap((source) =>
        [source.chunk.moduleUrl, source.chunk.sourceUrl].filter(
          (url): url is string => url !== undefined,
        ),
      ),
    );
    const warnings: SupportWarning[] = [];
    // An object, so the flag set inside the replacer is visible to the type checker.
    const removed = { url: false };
    const stripUrls = (text: string): string =>
      text.replace(URL_PATTERN, (url) => {
        if (knownUrls.has(url)) {
          return url;
        }
        removed.url = true;
        return '[link removed]';
      });

    const claims = answer.claims.map((claim) => ({
      text: stripUrls(claim.text),
      chunkIds: [
        ...new Set(
          claim.sourceIds.flatMap((id) => {
            const chunk = bySourceId.get(id);
            return chunk === undefined ? [] : [chunk.chunkId];
          }),
        ),
      ],
    }));
    const text = stripUrls(answer.answer.trim());
    if (answer.conflictingSources) {
      warnings.push('conflicting_sources');
    }
    if (removed.url) {
      warnings.push('unverified_url_removed');
    }
    return {
      insufficientEvidence: false,
      answer: text,
      claims,
      conflictingSources: answer.conflictingSources,
      warnings,
      modelWarnings,
    };
  }
}
