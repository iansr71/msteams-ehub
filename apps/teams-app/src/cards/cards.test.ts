import { answerResponseSchema } from '@ehub/shared/answers';
import { describe, expect, it } from 'vitest';

import { actions, answer, citation, elements, texts } from './__fixtures__/answers.js';
import { FEEDBACK_VERB, RETRY_VERB, cardActionDataSchema, retryAction } from './actions.js';
import { cardBytes } from './adaptiveCard.js';
import { TRUNCATION_NOTE, renderAnswerCard } from './answerCard.js';
import { locationLabel } from './sourceCard.js';
import {
  DEFAULT_SUGGESTED_QUESTIONS,
  renderErrorCard,
  renderWelcomeCard,
  type ErrorKind,
} from './statusCards.js';
import { cleanCardText, safeLink } from './text.js';

const options = {
  maxBytes: 24_000,
  allowedLinkHosts: undefined,
  question: 'How often should SPF be reapplied?',
};

describe('card text', () => {
  it('removes control and bidirectional characters, defuses templates and bounds length', () => {
    expect(cleanCardText('a\u0000b\u202Ec\u2066d', 100)).toBe('abcd');
    expect(cleanCardText('Due {{DATE(2026-01-01T00:00:00Z)}}', 100)).not.toContain('{{');
    expect(cleanCardText('  many    spaces\n\n\n\nlines ', 100)).toBe('many spaces\n\nlines');
    expect(cleanCardText('😀'.repeat(10), 5)).toBe(`${'😀'.repeat(4)}…`);
    expect(cleanCardText('é', 10)).toBe('é');
  });

  it('accepts only https links without credentials, on allowed hosts when set', () => {
    expect(safeLink('https://ehub.example.test/mod/page/view.php?id=1', undefined)).toBe(
      'https://ehub.example.test/mod/page/view.php?id=1',
    );
    for (const bad of [
      'http://ehub.example.test/x',
      'javascript:alert(1)',
      'https://user:pw@ehub.example.test/',
      'not a url',
      `https://e.test/${'a'.repeat(2100)}`,
    ]) {
      expect(safeLink(bad, undefined)).toBeUndefined();
    }
    const hosts = new Set(['ehub.example.test']);
    expect(safeLink('https://evil.example.com/', hosts)).toBeUndefined();
    expect(safeLink('https://EHUB.example.test/x', hosts)).toBe('https://ehub.example.test/x');
    expect(safeLink(undefined, hosts)).toBeUndefined();
  });

  it('labels pages and slides', () => {
    expect(locationLabel(citation())).toBe('p. 4');
    expect(locationLabel(citation({ pageNumberEnd: 6 }))).toBe('pp. 4-6');
    expect(locationLabel(citation({ pageNumber: undefined, slideNumber: 7 }))).toBe('slide 7');
    expect(locationLabel(citation({ pageNumber: undefined }))).toBeUndefined();
  });
});

describe('answer card', () => {
  it('shows the answer, supporting points, numbered sources, links and feedback', () => {
    const { card } = renderAnswerCard(answer(), options);
    const { plain, markdown } = texts(card);
    expect(markdown).toEqual(
      expect.arrayContaining(['Answer', 'Supporting points', 'Sources', 'Reference: answer-123']),
    );
    expect(plain).toContain('Reapply SPF 50 every two hours for two weeks after a peel. [1]');
    expect(plain).toContain('• Avoid direct sun for two weeks.');
    expect(plain).toContain(' [1][2]');
    expect(plain).toEqual(
      expect.arrayContaining([
        '[1] ',
        'Sun protection after peels',
        '[2] ',
        'Peel aftercare leaflet',
      ]),
    );
    expect(plain).toContain('Consultation Standards › Aftercare · p. 4');
    expect(plain).toContain('Consultation Standards › Aftercare · pp. 2-3');
    expect(plain).toContain('“Reapply broad-spectrum sunscreen every two hours.”');
    const all = actions(card);
    expect(all.filter((action) => action.type === 'Action.OpenUrl')).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'Open in E-Hub',
        url: 'https://ehub.example.test/mod/resource/view.php?id=701',
      },
    ]);
    const feedback = all.filter((action) => action.type === 'Action.Execute');
    expect(feedback.map((action) => action.verb)).toEqual([FEEDBACK_VERB, FEEDBACK_VERB]);
    for (const action of feedback) {
      {
        expect(cardActionDataSchema.parse(action.data)).toMatchObject({
          ehubAction: 'feedback',
          answerId: 'answer-123',
        });
        expect(action.fallback?.data).toEqual(action.data);
      }
    }
    expect(card.version).toBe('1.5');
  });

  it('renders untrusted text only as plain text runs, never as Markdown', () => {
    const hostile =
      '**Urgent** [Reset your password](https://evil.example.com) <script>alert(1)</script> {{DATE(2026-01-01T00:00:00Z)}}';
    const { card } = renderAnswerCard(
      answer({
        answer: hostile,
        claims: [
          { text: hostile, citationIds: [1] },
          { text: 'second', citationIds: [1] },
        ],
        citations: [
          citation({
            resourceName: hostile,
            courseName: hostile,
            sectionName: hostile,
            excerpt: hostile,
          }),
        ],
      }),
      options,
    );
    const { markdown } = texts(card);
    for (const text of markdown) {
      expect(text).not.toContain('evil.example.com');
      expect(text).not.toContain('Urgent');
    }
    expect(JSON.stringify(card)).not.toContain('{{DATE');
  });

  it('drops links that are not https or not on an allowed host', () => {
    const { card } = renderAnswerCard(
      answer({
        citations: [
          citation({ sourceUrl: 'http://ehub.example.test/x' }),
          citation({ citationId: 2, sourceUrl: 'https://other.example.com/x' }),
          citation({ citationId: 3, sourceUrl: 'https://ehub.example.test/ok' }),
        ],
      }),
      { ...options, allowedLinkHosts: new Set(['ehub.example.test']) },
    );
    expect(
      actions(card)
        .filter((action) => action.type === 'Action.OpenUrl')
        .map((action) => action.url),
    ).toEqual(['https://ehub.example.test/ok']);
  });

  it('omits supporting points that would repeat the answer', () => {
    const rebuilt = renderAnswerCard(answer({ warnings: ['answer_rebuilt_from_claims'] }), options);
    expect(texts(rebuilt.card).markdown).not.toContain('Supporting points');
    const single = renderAnswerCard(
      answer({ claims: [{ text: 'Only one.', citationIds: [1] }] }),
      options,
    );
    expect(texts(single.card).markdown).not.toContain('Supporting points');
  });

  it('warns about conflicting sources and marks the mock identity', () => {
    const { card } = renderAnswerCard(
      answer({ conflictingSources: true, mockIdentity: true }),
      options,
    );
    const markdown = texts(card).markdown.join('\n');
    expect(markdown).toContain('The sources do not fully agree');
    expect(markdown).toContain('Development mode — mock identity');
    expect(elements(card)[0]).toMatchObject({ type: 'Container', style: 'warning' });
  });

  it('stays within the size budget for the largest answers the contract allows', () => {
    const huge = answerResponseSchema.parse(
      answer({
        answer: '漢'.repeat(20_000),
        claims: Array.from({ length: 30 }, () => ({
          text: '😀'.repeat(2_000),
          citationIds: Array.from({ length: 20 }, (_, i) => i + 1),
        })),
        citations: Array.from({ length: 50 }, (_, index) =>
          citation({
            citationId: index + 1,
            resourceName: '"'.repeat(500),
            courseName: '\\'.repeat(500),
            sectionName: 'é'.repeat(500),
            excerpt: '😀'.repeat(1_000),
            sourceUrl: `https://ehub.example.test/${'a'.repeat(2_000)}`,
          }),
        ),
        warnings: Array.from({ length: 30 }, (_, i) => `warning_${String(i)}`),
      }),
    );
    for (const maxBytes of [8_000, 12_000, 24_000, 28_000]) {
      const rendered = renderAnswerCard(huge, { ...options, maxBytes });
      expect(rendered.bytes).toBeLessThanOrEqual(maxBytes);
      expect(cardBytes(rendered.card)).toBe(rendered.bytes);
      expect(rendered.detailLevel).toBeGreaterThan(0);
      expect(texts(rendered.card).markdown.join('\n')).toMatch(
        /shortened to fit Teams|more source\(s\) not shown/,
      );
    }
    const small = renderAnswerCard(answer(), options);
    expect(small.detailLevel).toBe(0);
    expect(texts(small.card).markdown).not.toContain(TRUNCATION_NOTE);
  });

  it('renders insufficient evidence clearly, and never presents an unsourced answer', () => {
    for (const response of [
      answer({ status: 'insufficient_evidence', answer: 'x', claims: [], citations: [] }),
      answer({ citations: [] }),
    ]) {
      const { card } = renderAnswerCard(response, options);
      const { markdown, plain } = texts(card);
      expect(markdown).toContain('Not enough information');
      expect(markdown.join('\n')).toContain('so I have not guessed');
      expect(markdown).not.toContain('Sources');
      expect(plain).toEqual([]);
      expect(
        actions(card).some(
          (action) => action.type === 'Action.Execute' && action.verb === FEEDBACK_VERB,
        ),
      ).toBe(true);
    }
  });

  it('offers "Ask again" when the engine failed', () => {
    const { card } = renderAnswerCard(
      answer({ status: 'failed', citations: [], claims: [] }),
      options,
    );
    expect(texts(card).markdown).toContain('No reliable answer');
    const retry = actions(card).find(
      (action) => action.type === 'Action.Execute' && action.verb === RETRY_VERB,
    );
    expect(retry?.type === 'Action.Execute' && cardActionDataSchema.parse(retry.data)).toEqual({
      ehubAction: 'retry',
      question: options.question,
    });
    expect(retryAction('x'.repeat(1_001))).toBeUndefined();
  });
});

describe('status cards', () => {
  it('welcomes with suggested questions posted back as the user', () => {
    const card = renderWelcomeCard({ mockIdentity: false });
    expect(texts(card).markdown[0]).toBe('E-Hub Knowledge Assistant');
    expect(card.actions?.map((action) => action.title)).toEqual(DEFAULT_SUGGESTED_QUESTIONS);
    expect(card.actions?.[0]).toMatchObject({
      type: 'Action.Submit',
      data: { msteams: { type: 'imBack', value: DEFAULT_SUGGESTED_QUESTIONS[0] } },
    });
    expect(texts(renderWelcomeCard({ mockIdentity: true })).markdown.join('\n')).toContain(
      'mock identity',
    );
  });

  it('renders every error kind with a reference and retry only where it helps', () => {
    const kinds: ErrorKind[] = [
      'timeout',
      'unavailable',
      'bad_response',
      'busy',
      'rate_limited',
      'question_too_long',
      'invalid_question',
      'identity_unavailable',
      'no_access',
      'personal_only',
    ];
    for (const kind of kinds) {
      const card = renderErrorCard({
        kind,
        reference: 'turn-1',
        mockIdentity: false,
        question: 'What?',
      });
      expect(texts(card).markdown).toContain('Reference: turn-1');
      const retryable = ['timeout', 'unavailable', 'bad_response', 'busy', 'rate_limited'].includes(
        kind,
      );
      expect((card.actions ?? []).length).toBe(retryable ? 1 : 0);
    }
    expect(
      texts(renderErrorCard({ kind: 'timeout', reference: 'bad ref\n', mockIdentity: false }))
        .markdown,
    ).toContain('Reference unavailable');
  });
});
