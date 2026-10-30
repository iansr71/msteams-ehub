import { redactString, sanitizeText } from '@ehub/shared';

import type { Citation } from './citationBuilder.js';

export interface FormattedClaim {
  readonly text: string;
  readonly citationIds: readonly number[];
}

export interface FormattedAnswer {
  /** The text shown to the user. */
  readonly answer: string;
  readonly claims: readonly FormattedClaim[];
  readonly citations: readonly Citation[];
}

const markers = (ids: readonly number[]): string => ids.map((id) => `[${String(id)}]`).join('');

/**
 * Decides what text is shown. The model's prose is used only when every claim survived and the
 * prose passed the same reference checks; otherwise the answer is rebuilt from the supported
 * claims, each followed by its citation markers, so nothing unsupported is shown.
 */
export class AnswerFormatter {
  format(input: {
    readonly prose: string;
    readonly proseTrusted: boolean;
    readonly claims: readonly FormattedClaim[];
    readonly citations: readonly Citation[];
  }): FormattedAnswer {
    const answer = input.proseTrusted
      ? input.prose.trim()
      : input.claims
          .map((claim) => `${claim.text.trim()} ${markers(claim.citationIds)}`)
          .join('\n');
    return { answer, claims: input.claims, citations: input.citations };
  }
}

function citationLocation(citation: Citation): string {
  if (citation.pageNumber !== undefined) {
    return citation.pageNumberEnd === undefined
      ? `page ${String(citation.pageNumber)}`
      : `pages ${String(citation.pageNumber)}-${String(citation.pageNumberEnd)}`;
  }
  return citation.slideNumber === undefined ? '' : `slide ${String(citation.slideNumber)}`;
}

/** One line per citation, e.g. `[1] Aftercare.pdf, page 3 — Consultation Skills > Aftercare`. */
export function formatCitationLine(citation: Citation): string {
  const location = citationLocation(citation);
  return [
    `[${String(citation.citationId)}] ${sanitizeText(citation.resourceName, 150)}`,
    location === '' ? '' : `, ${location}`,
    ` — ${sanitizeText(citation.courseName, 120)} > ${sanitizeText(citation.sectionName, 120)}`,
    citation.sourceUrl === undefined ? '' : ` (${citation.sourceUrl})`,
  ].join('');
}

/** Plain-text rendering for the CLI (and a basis for Teams in phase 12). */
export function formatAnswerAsText(
  answer: FormattedAnswer,
  options: { excerpts: boolean },
): string {
  const lines = answer.answer.split('\n').map((line) => sanitizeText(line, 2_000));
  if (answer.citations.length > 0) {
    lines.push('', 'Sources:');
    for (const citation of answer.citations) {
      lines.push(`  ${formatCitationLine(citation)}`);
      if (options.excerpts) {
        lines.push(`      "${citation.excerpt}"`);
      }
    }
  }
  return redactString(lines.join('\n'));
}
