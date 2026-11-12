import { describe, expect, it } from 'vitest';

import { renderAnswerCard } from '../../apps/teams-app/src/cards/answerCard.js';
import { renderErrorCard, renderWelcomeCard } from '../../apps/teams-app/src/cards/statusCards.js';
import {
  actions,
  answer,
  citation,
  texts,
} from '../../apps/teams-app/src/cards/__fixtures__/answers.js';

/*
 * Acceptance suite 11: what a staff member sees in Teams. The card must show the answer with
 * numbered sources, stay inside the size budget, render nothing as markup, and never show an
 * answer that has no sources.
 */

const options = {
  maxBytes: 24_000,
  allowedLinkHosts: new Set(['ehub.example.test']),
  question: 'What aftercare applies after a peel?',
};

function cardText(card: unknown): string {
  return JSON.stringify(card);
}

describe('11 Teams rendering', () => {
  it('shows the answer, its supporting points and numbered sources', () => {
    const { card, bytes } = renderAnswerCard(answer(), options);
    const { plain, markdown } = texts(card);
    expect(markdown).toEqual(expect.arrayContaining(['Answer', 'Sources']));
    expect(plain.join(' ')).toContain('[1]');
    expect(bytes).toBeLessThanOrEqual(options.maxBytes);
    expect(actions(card).length).toBeGreaterThan(0);
  });

  it('stays inside a small size budget by reducing detail', () => {
    const long = answer({
      citations: Array.from({ length: 8 }, (_unused, index) =>
        citation({ citationId: index + 1, excerpt: 'A fairly long excerpt. '.repeat(20) }),
      ),
    });
    const { bytes, detailLevel } = renderAnswerCard(long, {
      ...options,
      maxBytes: 8_000,
    });
    expect(bytes).toBeLessThanOrEqual(8_000);
    expect(detailLevel).toBeGreaterThan(0);
  });

  it('shows an answer with no citations as insufficient evidence', () => {
    const { card } = renderAnswerCard(answer({ citations: [], claims: [] }), {
      ...options,
    });
    expect(cardText(card)).not.toContain('Sources');
  });

  it('renders text as plain runs, so markup and templates cannot execute', () => {
    const hostile = answer({
      answer: '<script>alert(1)</script> **bold** {{DATE(2026-01-01T00:00:00Z)}} [x](javascript:1)',
      claims: [{ text: '<img src=x onerror=alert(1)>', citationIds: [1] }],
    });
    const { card } = renderAnswerCard(hostile, options);
    const json = cardText(card);
    // Date and time templates are defused, so Teams cannot expand them.
    expect(json).not.toContain('{{DATE(');
    // The hostile text is still shown, as inert text in a TextRun: Adaptive Cards do not
    // interpret a run as Markdown or HTML, so there is nothing to execute.
    const { plain } = texts(card);
    expect(plain.join(' ')).toContain('alert(1)');
    // What matters is that none of it reached a link or an action.
    for (const action of actions(card)) {
      const url = (action as { url?: string }).url ?? '';
      expect(url).not.toMatch(/^javascript:/i);
    }
    expect(json).not.toMatch(/"url"\s*:\s*"javascript:/i);
  });

  it('links only to allowed hosts', () => {
    const foreign = answer({
      citations: [citation({ citationId: 1, sourceUrl: 'https://attacker.example/evil.pdf' })],
    });
    const { card } = renderAnswerCard(foreign, options);
    expect(cardText(card)).not.toContain('attacker.example');
  });

  it('renders the welcome and error cards without leaking detail', () => {
    const welcome = renderWelcomeCard({ mockIdentity: false });
    expect(cardText(welcome)).not.toContain('undefined');
    const error = renderErrorCard({
      kind: 'unavailable',
      reference: 'abc-123',
      mockIdentity: false,
    });
    const json = cardText(error);
    expect(json).toContain('abc-123');
    expect(json).not.toMatch(/stack|at Object\./i);
  });
});
