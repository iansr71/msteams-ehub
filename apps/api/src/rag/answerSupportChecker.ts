import { sanitizeText } from '@ehub/shared';

import { INSUFFICIENT_EVIDENCE_MESSAGE, type ModelAnswer } from './answerSchema.js';
import { AnswerFormatter } from './answerFormatter.js';
import { CitationBuilder, type Citation } from './citationBuilder.js';
import { validateClaimCitations, type CitationScope } from './citationValidator.js';
import { ClaimSupportValidator, type ClaimIssue } from './claimSupportValidator.js';
import type { PromptSource } from './promptBuilder.js';

export type SupportWarning =
  | 'conflicting_sources'
  | 'unsupported_claims_removed'
  | 'citation_rejected'
  | 'answer_rebuilt_from_claims'
  | 'no_supported_claims'
  | 'source_link_withheld';

export interface CheckedClaim {
  readonly text: string;
  readonly citationIds: readonly number[];
  readonly chunkIds: readonly string[];
}

export interface CheckedAnswer {
  readonly insufficientEvidence: boolean;
  readonly answer: string;
  readonly claims: readonly CheckedClaim[];
  readonly citations: readonly Citation[];
  readonly conflictingSources: boolean;
  readonly warnings: readonly SupportWarning[];
  /** The model's own warnings, sanitised and bounded. */
  readonly modelWarnings: readonly string[];
  /** Claims dropped because they were not supported, and why (issue counts). */
  readonly removedClaims: number;
  readonly issues: Readonly<Partial<Record<ClaimIssue, number>>>;
}

export interface AnswerSupportCheckerOptions {
  readonly excerptChars: number;
}

/**
 * Turns a valid model answer into a cited answer, or the insufficient-evidence response.
 *
 * 1. Each claim's citations are mapped to chunks retrieved for this request and within its
 *    courses (unknown or unauthorised ones are dropped).
 * 2. Each claim is checked against its cited chunks (pages, slides, links, document names,
 *    numbers, shared words). Unsupported claims are removed.
 * 3. If nothing supported remains, or more claims were removed than kept, the answer is refused.
 * 4. Citations are built from retrieval metadata and numbered by first use.
 * 5. The model's prose is shown only if no claim was removed and the prose passes the same
 *    checks; otherwise the answer is rebuilt from the supported claims.
 */
export class AnswerSupportChecker {
  readonly #claims = new ClaimSupportValidator();
  readonly #citations: CitationBuilder;
  readonly #formatter = new AnswerFormatter();

  constructor(options: AnswerSupportCheckerOptions = { excerptChars: 200 }) {
    this.#citations = new CitationBuilder(options.excerptChars);
  }

  check(
    answer: ModelAnswer,
    sources: readonly PromptSource[],
    scope: CitationScope,
  ): CheckedAnswer {
    const modelWarnings = answer.warnings
      .map((warning) => sanitizeText(warning, 200))
      .filter((warning) => warning !== '-');
    const insufficient = (
      warnings: SupportWarning[],
      removedClaims = 0,
      issues: Partial<Record<ClaimIssue, number>> = {},
    ): CheckedAnswer => ({
      insufficientEvidence: true,
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      claims: [],
      citations: [],
      conflictingSources: false,
      warnings,
      modelWarnings,
      removedClaims,
      issues,
    });

    if (answer.insufficientEvidence) {
      return insufficient([]);
    }
    if (answer.claims.length === 0 || answer.answer.trim() === '') {
      return insufficient(['no_supported_claims']);
    }

    const warnings = new Set<SupportWarning>();
    const issues: Partial<Record<ClaimIssue, number>> = {};
    const supported: { text: string; chunks: PromptSource['chunk'][] }[] = [];
    for (const claim of answer.claims) {
      const validated = validateClaimCitations(claim.sourceIds, sources, scope);
      if (validated.rejected.length > 0) {
        warnings.add('citation_rejected');
      }
      const check = this.#claims.check(claim.text, validated.chunks);
      for (const issue of check.issues) {
        issues[issue] = (issues[issue] ?? 0) + 1;
      }
      if (check.supported) {
        supported.push({ text: claim.text, chunks: [...validated.chunks] });
      }
    }
    const removedClaims = answer.claims.length - supported.length;
    if (supported.length === 0 || removedClaims > supported.length) {
      return insufficient(['no_supported_claims'], removedClaims, issues);
    }
    if (removedClaims > 0) {
      warnings.add('unsupported_claims_removed');
    }

    const built = this.#citations.build(supported, scope);
    if (built.citations.length === 0) {
      return insufficient(['no_supported_claims'], removedClaims, issues);
    }
    const allCited = supported.flatMap((claim) => claim.chunks);
    const chunkById = new Map(allCited.map((chunk) => [chunk.chunkId, chunk]));
    const linkWithheld = built.citations.some((citation) => {
      const chunk = chunkById.get(citation.chunkId);
      return (
        citation.sourceUrl === undefined &&
        (chunk?.moduleUrl !== undefined || chunk?.sourceUrl !== undefined)
      );
    });
    if (linkWithheld) {
      warnings.add('source_link_withheld');
    }
    const proseTrusted =
      removedClaims === 0 && this.#claims.check(answer.answer, allCited).supported;
    if (!proseTrusted) {
      warnings.add('answer_rebuilt_from_claims');
    }
    if (answer.conflictingSources) {
      warnings.add('conflicting_sources');
    }
    const claims = supported.map((claim, index) => ({
      text: claim.text,
      citationIds: built.claimCitationIds[index] ?? [],
      chunkIds: [...new Set(claim.chunks.map((chunk) => chunk.chunkId))],
    }));
    const formatted = this.#formatter.format({
      prose: answer.answer,
      proseTrusted,
      claims,
      citations: built.citations,
    });
    return {
      insufficientEvidence: false,
      answer: formatted.answer,
      claims,
      citations: formatted.citations,
      conflictingSources: answer.conflictingSources,
      warnings: [...warnings],
      modelWarnings,
      removedClaims,
      issues,
    };
  }
}

/**
 * The invariant every returned answer must meet: either the explicit insufficient-evidence
 * response, or at least one valid citation with every claim citing at least one of them.
 */
export function answerHasValidSources(answer: {
  readonly insufficientEvidence: boolean;
  readonly answer: string;
  readonly claims: readonly { readonly citationIds: readonly number[] }[];
  readonly citations: readonly { readonly citationId: number }[];
}): boolean {
  if (answer.insufficientEvidence) {
    return answer.answer === INSUFFICIENT_EVIDENCE_MESSAGE && answer.claims.length === 0;
  }
  const ids = new Set(answer.citations.map((citation) => citation.citationId));
  return (
    answer.citations.length > 0 &&
    answer.claims.length > 0 &&
    answer.claims.every(
      (claim) => claim.citationIds.length > 0 && claim.citationIds.every((id) => ids.has(id)),
    )
  );
}
