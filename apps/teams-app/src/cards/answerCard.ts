import type { AnswerResponse } from '@ehub/shared/answers';

import { feedbackActions, retryAction } from './actions.js';
import {
  adaptiveCard,
  cardBytes,
  fixedText,
  type AdaptiveCard,
  type CardElement,
} from './adaptiveCard.js';
import { FULL_SOURCE_OPTIONS, renderSource } from './sourceCard.js';
import { mockIdentityBanner, referenceLine } from './statusCards.js';
import { richText, run } from './text.js';

export interface AnswerRenderOptions {
  /** Serialised size budget in bytes (TEAMS_CARD_MAX_BYTES). */
  readonly maxBytes: number;
  readonly allowedLinkHosts: ReadonlySet<string> | undefined;
  /** The user's question, for "Ask again" on a failed answer. */
  readonly question: string;
}

interface Detail {
  readonly answerChars: number;
  readonly claims: number;
  readonly sources: number;
  readonly excerpts: boolean;
  readonly nameChars: number;
}

/**
 * Detail levels tried in order until the card fits the budget: drop excerpts, then supporting
 * points, then show fewer sources and shorter text. The last level fits any response the
 * contract allows at the smallest budget (tested); a fixed short card is the final fallback.
 */
const DETAIL_LEVELS: readonly Detail[] = [
  { answerChars: 3_000, claims: 8, sources: 8, excerpts: true, nameChars: 160 },
  { answerChars: 3_000, claims: 8, sources: 8, excerpts: false, nameChars: 160 },
  { answerChars: 2_000, claims: 0, sources: 8, excerpts: false, nameChars: 120 },
  { answerChars: 1_200, claims: 0, sources: 4, excerpts: false, nameChars: 80 },
  { answerChars: 500, claims: 0, sources: 3, excerpts: false, nameChars: 60 },
  { answerChars: 400, claims: 0, sources: 2, excerpts: false, nameChars: 40 },
];

export const TRUNCATION_NOTE =
  'Part of this answer was shortened to fit Teams. Open the sources for the full detail.';

/**
 * The supporting points repeat the answer when the API rebuilt the answer from its claims, or
 * when there is only one claim; they are shown only when they add something.
 */
function showsSupportingPoints(response: AnswerResponse): boolean {
  return response.claims.length > 1 && !response.warnings.includes('answer_rebuilt_from_claims');
}

function citationMarkers(ids: readonly number[]): string {
  return ids.map((id) => `[${String(id)}]`).join('');
}

function buildAnswered(
  response: AnswerResponse,
  options: AnswerRenderOptions,
  detail: Detail,
  level: number,
): AdaptiveCard {
  const body: CardElement[] = [];
  if (response.mockIdentity) {
    body.push(mockIdentityBanner());
  }
  body.push(fixedText('Answer', { weight: 'Bolder', size: 'Medium' }));
  body.push(richText([run(response.answer, detail.answerChars)]));
  if (response.conflictingSources) {
    body.push({
      type: 'Container',
      style: 'attention',
      items: [
        fixedText('The sources do not fully agree. Check them before acting on this answer.', {
          size: 'Small',
        }),
      ],
    });
  }
  if (detail.claims > 0 && showsSupportingPoints(response)) {
    body.push(fixedText('Supporting points', { weight: 'Bolder', spacing: 'Medium' }));
    for (const claim of response.claims.slice(0, detail.claims)) {
      body.push(
        richText(
          [
            run(`• ${claim.text}`, 500),
            run(` ${citationMarkers(claim.citationIds)}`, 60, { isSubtle: true }),
          ],
          'Small',
        ),
      );
    }
  }
  body.push(fixedText('Sources', { weight: 'Bolder', spacing: 'Medium' }));
  for (const citation of response.citations.slice(0, detail.sources)) {
    body.push(
      renderSource(citation, {
        ...FULL_SOURCE_OPTIONS,
        includeExcerpt: detail.excerpts,
        nameChars: detail.nameChars,
        allowedLinkHosts: options.allowedLinkHosts,
      }),
    );
  }
  const hidden = response.citations.length - Math.min(response.citations.length, detail.sources);
  if (hidden > 0) {
    body.push(
      fixedText(`${String(hidden)} more source(s) not shown.`, { isSubtle: true, size: 'Small' }),
    );
  }
  if (level > 1) {
    body.push(fixedText(TRUNCATION_NOTE, { isSubtle: true, size: 'Small' }));
  }
  body.push(referenceLine(response.answerId));
  return adaptiveCard(body, feedbackActions(response.answerId));
}

function buildInsufficient(response: AnswerResponse): AdaptiveCard {
  const body: CardElement[] = [];
  if (response.mockIdentity) {
    body.push(mockIdentityBanner());
  }
  body.push({
    type: 'Container',
    style: 'emphasis',
    items: [
      fixedText('Not enough information', { weight: 'Bolder' }),
      fixedText(
        'I could not find enough information in the E-Hub courses you can access to answer that reliably, so I have not guessed.',
      ),
    ],
  });
  body.push(
    fixedText(
      '- Name the treatment, product or procedure\n- Ask one question at a time\n- Check the E-Hub course directly, or ask your trainer',
      { size: 'Small', spacing: 'Medium' },
    ),
  );
  body.push(referenceLine(response.answerId));
  return adaptiveCard(body, feedbackActions(response.answerId));
}

function buildFailed(response: AnswerResponse, options: AnswerRenderOptions): AdaptiveCard {
  const retry = retryAction(options.question);
  return adaptiveCard(
    [
      ...(response.mockIdentity ? [mockIdentityBanner()] : []),
      {
        type: 'Container',
        style: 'attention',
        items: [
          fixedText('No reliable answer', { weight: 'Bolder' }),
          fixedText(
            'Sorry, I could not produce a reliable answer right now. Please try again, or check the E-Hub course directly.',
          ),
        ],
      },
      referenceLine(response.answerId),
    ],
    retry === undefined ? undefined : [retry],
  );
}

export interface RenderedCard {
  readonly card: AdaptiveCard;
  readonly bytes: number;
  /** 0 = full detail; higher = reduced to fit. */
  readonly detailLevel: number;
}

/**
 * Renders the API's answer. An `answered` response without citations is shown as insufficient
 * evidence: the API never sends one, but the card must not present an unsourced answer if it did.
 */
export function renderAnswerCard(
  response: AnswerResponse,
  options: AnswerRenderOptions,
): RenderedCard {
  if (response.status === 'failed') {
    const card = buildFailed(response, options);
    return { card, bytes: cardBytes(card), detailLevel: 0 };
  }
  if (response.status === 'insufficient_evidence' || response.citations.length === 0) {
    const card = buildInsufficient(response);
    return { card, bytes: cardBytes(card), detailLevel: 0 };
  }
  for (const [level, detail] of DETAIL_LEVELS.entries()) {
    const card = buildAnswered(response, options, detail, level);
    const bytes = cardBytes(card);
    if (bytes <= options.maxBytes) {
      return { card, bytes, detailLevel: level };
    }
  }
  // Not reached with the contract's limits and the smallest allowed budget (8000 bytes); a
  // hard guarantee that nothing larger than the budget is ever sent.
  const card = adaptiveCard(
    [
      fixedText(
        'The answer is too long to show in Teams. Please ask a narrower question, or check the E-Hub course directly.',
      ),
      referenceLine(response.answerId),
    ],
    feedbackActions(response.answerId),
  );
  return { card, bytes: cardBytes(card), detailLevel: DETAIL_LEVELS.length };
}
