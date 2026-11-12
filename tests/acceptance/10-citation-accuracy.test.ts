import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { createEndToEndStack, type EndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 10: every citation points at a chunk that was actually retrieved, carries the
 * metadata a reader needs to find it in Moodle, and links only to the Moodle site.
 */

async function indexedStack(): Promise<EndToEndStack> {
  const stack = await createEndToEndStack();
  stack.harness.site.addCourse(12, { name: 'Chemical peels' });
  stack.harness.site.setPage(12, 701, {
    name: 'Peel aftercare',
    html: pageHtml('Peel aftercare', [
      'Reapply broad-spectrum sunscreen every two hours after a chemical peel.',
    ]),
  });
  await incrementalSync(await stack.harness.services(), { jobId: 'corpus' });
  return stack;
}

describe('10 Citation accuracy', () => {
  it('maps every citation to a retrieved chunk of an authorised course', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('How often should sunscreen be reapplied after a peel?');
    expect(answer.citations.length).toBeGreaterThan(0);
    const retrieved = new Set(answer.sources.map((source) => source.resourceId));
    for (const citation of answer.citations) {
      expect(retrieved).toContain(citation.resourceId);
      expect(citation.courseId).toBe(12);
      expect(citation.resourceId).toMatch(/^701/);
    }
  });

  it('gives each citation the metadata needed to find it in Moodle', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('How often should sunscreen be reapplied after a peel?');
    for (const citation of answer.citations) {
      expect(citation.courseName).toBe('Chemical peels');
      expect(citation.resourceName).toBe('Peel aftercare');
      expect(citation.sectionName.length).toBeGreaterThan(0);
      expect(citation.excerpt.length).toBeGreaterThan(0);
      expect(citation.moduleId).toBe(701);
      if (citation.sourceUrl !== undefined) {
        expect(new URL(citation.sourceUrl).host).toBe(new URL(stack.moodleBaseUrl).host);
      }
    }
  });

  it('numbers citations from one and keeps claim references in step', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('How often should sunscreen be reapplied after a peel?');
    const ids = answer.citations.map((citation) => citation.citationId);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_unused, index) => index + 1));
    const known = new Set(ids);
    for (const claim of answer.claims) {
      expect(claim.citationIds.length).toBeGreaterThan(0);
      for (const id of claim.citationIds) {
        expect(known).toContain(id);
      }
    }
  });

  it('drops a citation the model invented', async () => {
    const stack = await indexedStack();
    const text = 'Reapply broad-spectrum sunscreen every two hours after a chemical peel.';
    const answer = await stack.ask('How often should sunscreen be reapplied?', {
      reply: JSON.stringify({
        answer: text,
        claims: [
          { text, sourceIds: ['S1'] },
          { text: 'An extra note from somewhere else.', sourceIds: ['S77'] },
        ],
        insufficientEvidence: false,
        conflictingSources: false,
        warnings: [],
      }),
    });
    expect(answer.citations.every((citation) => citation.resourceId.startsWith('701'))).toBe(true);
    expect(answer.claims.some((claim) => claim.text.includes('somewhere else'))).toBe(false);
    expect(answer.removedClaims).toBeGreaterThan(0);
  });

  it('never cites a resource that was not retrieved for this question', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', ['Reapply sunscreen every two hours after a peel.']),
    });
    stack.harness.site.setPage(12, 702, {
      name: 'Stock control',
      html: pageHtml('Stock control', ['Count the consumables in the store room each Friday.']),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'two-pages' });
    const answer = await stack.ask('How often should sunscreen be reapplied after a peel?');
    const retrieved = new Set(answer.sources.map((source) => source.resourceId));
    for (const citation of answer.citations) {
      expect(retrieved).toContain(citation.resourceId);
    }
  });
});
