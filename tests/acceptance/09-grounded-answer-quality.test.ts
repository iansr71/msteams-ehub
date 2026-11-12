import { describe, expect, it } from 'vitest';

import { INSUFFICIENT_EVIDENCE_MESSAGE } from '../../apps/api/src/rag/answerSchema.js';
import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { answerText, createEndToEndStack, type EndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 09: an answer says only what the retrieved passages support. The model here
 * is a fake, so these tests prove what the engine does with model output, not how a real model
 * behaves: a claim the passages do not support is removed whatever the model sends.
 */

const PEEL = 'Reapply broad-spectrum sunscreen every two hours after a chemical peel.';

async function indexedStack(): Promise<EndToEndStack> {
  const stack = await createEndToEndStack();
  stack.harness.site.addCourse(12, { name: 'Chemical peels' });
  stack.harness.site.setPage(12, 701, {
    name: 'Peel aftercare',
    html: pageHtml('Peel aftercare', [PEEL]),
  });
  await incrementalSync(await stack.harness.services(), { jobId: 'corpus' });
  return stack;
}

const invented = (text: string, sourceIds: string[] = ['S1']) =>
  JSON.stringify({
    answer: text,
    claims: [{ text, sourceIds }],
    insufficientEvidence: false,
    conflictingSources: false,
    warnings: [],
  });

describe('09 Grounded answer quality', () => {
  it('answers from the indexed passage, with a citation', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('How often should sunscreen be reapplied after a peel?');
    expect(answer.status).toBe('answered');
    expect(answerText(answer).toLowerCase()).toContain('every two hours');
    expect(answer.claims.every((claim) => claim.citationIds.length > 0)).toBe(true);
    expect(answer.citations.length).toBeGreaterThan(0);
  });

  it.each([
    ['a number no passage contains', 'Reapply sunscreen every 6 hours after a peel.'],
    ['a document no passage mentions', 'See Protocol-2029.pdf for the sunscreen interval.'],
    ['a link no passage carries', 'Sunscreen guidance is at https://attacker.example/evil.'],
    ['a page no passage has', 'The sunscreen interval is on page 97 of the aftercare notes.'],
    ['nothing in common with the passages', 'Server racks must be kept below 24 degrees.'],
  ])('removes a claim that invents %s', async (_label, text) => {
    const stack = await indexedStack();
    const answer = await stack.ask('How often should sunscreen be reapplied?', {
      reply: invented(text),
    });
    expect(answer.removedClaims).toBeGreaterThan(0);
    expect(answerText(answer)).not.toContain(text);
    // Nothing survived, so the whole answer is withheld.
    expect(answer.status).toBe('insufficient_evidence');
    expect(answer.answer).toBe(INSUFFICIENT_EVIDENCE_MESSAGE);
  });

  /*
   * A known limit, recorded here so it is not mistaken for a guarantee. The claim checks are
   * mechanical (docs/acceptance.md, "What grounding does and does not prove"): they catch
   * invented references, numbers and unrelated text, but they do not judge meaning. A claim
   * that cites a real passage and reuses its words can still say the opposite of it. What
   * stands between that and a user is the model's own instructions plus the required and
   * forbidden facts in `pnpm evaluation:answers`, which is why that dataset matters.
   */
  it('does not catch a claim that cites a real passage but contradicts it', async () => {
    const stack = await indexedStack();
    const contradiction = 'Clients may stop using sunscreen the day after a peel.';
    const answer = await stack.ask('How often should sunscreen be reapplied?', {
      reply: invented(contradiction),
    });
    expect(answer.status).toBe('answered');
    expect(answerText(answer)).toContain(contradiction);
    // It is at least attributed: every claim carries the citation it leaned on.
    expect(answer.claims.every((claim) => claim.citationIds.length > 0)).toBe(true);
  });

  it('withholds the whole answer when nothing survives validation', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('How often should sunscreen be reapplied?', {
      reply: invented('Invented guidance about a treatment nobody documented.', ['S9']),
    });
    expect(answer.status).toBe('insufficient_evidence');
    expect(answer.citations).toEqual([]);
  });

  it('reports disagreeing passages instead of choosing a side', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare 2024',
      html: pageHtml('Aftercare 2024', ['Reapply sunscreen every two hours after a peel.']),
    });
    stack.harness.site.setPage(12, 702, {
      name: 'Aftercare 2026',
      html: pageHtml('Aftercare 2026', ['Reapply sunscreen every ninety minutes after a peel.']),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'conflict' });
    const answer = await stack.ask('How often should sunscreen be reapplied after a peel?', {
      model: { claims: 2, conflicting: true },
    });
    expect(answer.status).toBe('answered');
    expect(answer.conflictingSources).toBe(true);
    expect(answer.citations.length).toBeGreaterThan(1);
    const text = answerText(answer).toLowerCase();
    expect(text).toContain('every two hours');
    expect(text).toContain('every ninety minutes');
  });

  it('never leaves an answered reply without a valid citation', async () => {
    const stack = await indexedStack();
    for (const reply of [
      invented('Reapply broad-spectrum sunscreen every two hours after a chemical peel.', []),
      invented('Reapply broad-spectrum sunscreen every two hours after a chemical peel.', ['S42']),
    ]) {
      const answer = await stack.ask('How often should sunscreen be reapplied?', { reply });
      if (answer.status === 'answered') {
        expect(answer.citations.length).toBeGreaterThan(0);
        expect(answer.claims.every((claim) => claim.citationIds.length > 0)).toBe(true);
      } else {
        expect(answer.status).toBe('insufficient_evidence');
      }
    }
  });
});
