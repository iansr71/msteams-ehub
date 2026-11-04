import type { AnswerCitation } from '@ehub/shared/answers';

import type { CardElement, Container } from './adaptiveCard.js';
import { cleanCardText, richText, run, safeLink } from './text.js';

export interface SourceRenderOptions {
  readonly includeExcerpt: boolean;
  readonly nameChars: number;
  readonly excerptChars: number;
  readonly allowedLinkHosts: ReadonlySet<string> | undefined;
}

export const FULL_SOURCE_OPTIONS = {
  includeExcerpt: true,
  nameChars: 160,
  excerptChars: 200,
} as const;

/** "p. 4", "pp. 4-6", "slide 7", or nothing. */
export function locationLabel(citation: AnswerCitation): string | undefined {
  if (citation.slideNumber !== undefined) {
    return `slide ${String(citation.slideNumber)}`;
  }
  if (citation.pageNumber === undefined) {
    return undefined;
  }
  return citation.pageNumberEnd !== undefined && citation.pageNumberEnd !== citation.pageNumber
    ? `pp. ${String(citation.pageNumber)}-${String(citation.pageNumberEnd)}`
    : `p. ${String(citation.pageNumber)}`;
}

/**
 * One numbered source: resource name, course › section and page or slide, an optional
 * excerpt, and "Open in E-Hub" when an approved https link exists. Every value comes from the
 * API's validated citation and is rendered as plain text.
 */
export function renderSource(citation: AnswerCitation, options: SourceRenderOptions): Container {
  const where = [
    cleanCardText(citation.courseName, options.nameChars),
    cleanCardText(citation.sectionName, options.nameChars),
  ]
    .filter((part) => part !== '')
    .join(' › ');
  const location = locationLabel(citation);
  const items: CardElement[] = [
    richText([
      run(`[${String(citation.citationId)}] `, 10, { weight: 'Bolder' }),
      run(citation.resourceName, options.nameChars, { weight: 'Bolder' }),
    ]),
    richText(
      [
        run(location === undefined ? where : `${where} · ${location}`, options.nameChars * 2 + 20, {
          isSubtle: true,
          size: 'Small',
        }),
      ],
      'None',
    ),
  ];
  if (options.includeExcerpt && citation.excerpt.trim() !== '') {
    items.push(
      richText(
        [
          run(
            `“${cleanCardText(citation.excerpt, options.excerptChars)}”`,
            options.excerptChars + 2,
            { italic: true, isSubtle: true, size: 'Small' },
          ),
        ],
        'Small',
      ),
    );
  }
  const link = safeLink(citation.sourceUrl, options.allowedLinkHosts);
  if (link !== undefined) {
    items.push({
      type: 'ActionSet',
      actions: [{ type: 'Action.OpenUrl', title: 'Open in E-Hub', url: link }],
    });
  }
  return { type: 'Container', items, separator: true, spacing: 'Medium' };
}
