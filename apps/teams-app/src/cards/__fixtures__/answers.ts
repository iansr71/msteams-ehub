import type { AnswerCitation, AnswerResponse } from '@ehub/shared/answers';

import type { AdaptiveCard, CardAction, CardElement } from '../adaptiveCard.js';

export function citation(overrides: Partial<AnswerCitation> = {}): AnswerCitation {
  return {
    citationId: 1,
    courseId: 12,
    courseName: 'Consultation Standards',
    sectionName: 'Aftercare',
    moduleId: 701,
    resourceName: 'Sun protection after peels',
    resourceType: 'pdf',
    pageNumber: 4,
    sourceUrl: 'https://ehub.example.test/mod/resource/view.php?id=701',
    excerpt: 'Reapply broad-spectrum sunscreen every two hours.',
    ...overrides,
  };
}

export function answer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    answerId: 'answer-123',
    status: 'answered',
    answer: 'Reapply SPF 50 every two hours for two weeks after a peel. [1]',
    claims: [
      { text: 'Reapply SPF 50 every two hours.', citationIds: [1] },
      { text: 'Avoid direct sun for two weeks.', citationIds: [1, 2] },
    ],
    citations: [
      citation(),
      citation({
        citationId: 2,
        resourceName: 'Peel aftercare leaflet',
        pageNumber: 2,
        pageNumberEnd: 3,
        sourceUrl: undefined,
      }),
    ],
    conflictingSources: false,
    warnings: [],
    mockIdentity: false,
    ...overrides,
  };
}

/** Every element in a card, depth first. */
export function elements(card: AdaptiveCard): CardElement[] {
  const out: CardElement[] = [];
  const visit = (items: readonly CardElement[]): void => {
    for (const item of items) {
      out.push(item);
      if (item.type === 'Container') {
        visit(item.items);
      }
    }
  };
  visit(card.body);
  return out;
}

export function actions(card: AdaptiveCard): CardAction[] {
  return [
    ...elements(card).flatMap((element) => (element.type === 'ActionSet' ? element.actions : [])),
    ...(card.actions ?? []),
  ];
}

/** Text shown through TextRun (plain text) and TextBlock (Markdown) respectively. */
export function texts(card: AdaptiveCard): { plain: string[]; markdown: string[] } {
  const plain: string[] = [];
  const markdown: string[] = [];
  for (const element of elements(card)) {
    if (element.type === 'RichTextBlock') {
      plain.push(...element.inlines.map((inline) => inline.text));
    } else if (element.type === 'TextBlock') {
      markdown.push(element.text);
    }
  }
  return { plain, markdown };
}
