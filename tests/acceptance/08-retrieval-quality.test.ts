import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { createEndToEndStack, type EndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 08: a question reaches the passage that answers it, and retrieval never
 * crosses a course boundary. Ranking quality against real E-Hub content is measured separately
 * by `pnpm evaluation:retrieval` with a dataset of real questions.
 */

const PEEL = 'Reapply broad-spectrum sunscreen every two hours after a chemical peel.';
const LASER = 'Everyone in the room must wear wavelength-specific eyewear during laser treatment.';
const CONSENT = 'Written consent must be signed before any treatment begins.';

async function indexedStack(): Promise<EndToEndStack> {
  const stack = await createEndToEndStack();
  const { site } = stack.harness;
  site.addCourse(12, { name: 'Chemical peels' });
  site.addCourse(13, { name: 'Laser safety' });
  site.setPage(12, 701, { name: 'Peel aftercare', html: pageHtml('Peel aftercare', [PEEL]) });
  site.setPage(12, 702, { name: 'Consent', html: pageHtml('Consent', [CONSENT]) });
  site.setPage(13, 801, { name: 'Laser eyewear', html: pageHtml('Laser eyewear', [LASER]) });
  await incrementalSync(await stack.harness.services({ settings: { courseIds: [12, 13] } }), {
    jobId: 'corpus',
  });
  return stack;
}

describe('08 Retrieval quality', () => {
  it('retrieves the passage that answers the question', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('How often should sunscreen be reapplied after a peel?', {
      authorizedCourseIds: [12, 13],
    });
    expect(answer.status).toBe('answered');
    expect(answer.sources[0]?.resourceId).toMatch(/^701/);
    expect(answer.retrieval?.returned ?? 0).toBeGreaterThan(0);
  });

  it('retrieves nothing from a course the user may not read', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('What eyewear is required during laser treatment?', {
      authorizedCourseIds: [12],
    });
    expect(answer.sources.every((source) => source.courseId === 12)).toBe(true);
    expect(answer.citations.every((citation) => citation.courseId === 12)).toBe(true);
    const text = [answer.answer, ...answer.claims.map((claim) => claim.text)].join(' ');
    expect(text).not.toContain('wavelength-specific');
  });

  it('honours a narrower course selection than the user’s access', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('What eyewear is required during laser treatment?', {
      authorizedCourseIds: [12, 13],
      selectedCourseIds: [12],
    });
    expect(answer.sources.every((source) => source.courseId === 12)).toBe(true);
  });

  it('returns the insufficient-evidence reply when the courses do not cover the question', async () => {
    const stack = await indexedStack();
    const answer = await stack.ask('What is the clinic’s electricity tariff?', {
      authorizedCourseIds: [12, 13],
      // A model that quotes nothing, as it has nothing relevant to quote.
      reply: JSON.stringify({
        answer: '',
        claims: [],
        insufficientEvidence: true,
        conflictingSources: false,
        warnings: [],
      }),
    });
    expect(answer.status).toBe('insufficient_evidence');
    expect(answer.citations).toEqual([]);
  });

  it('caps how much of one resource can crowd out the rest', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setPage(12, 701, {
      name: 'Long protocol',
      html: pageHtml(
        'Long protocol',
        Array.from(
          { length: 40 },
          (_unused, index) =>
            `Step ${String(index + 1)}: reapply sunscreen, check the client file and record the outcome before the next stage of the protocol.`,
        ),
      ),
    });
    await incrementalSync(await stack.harness.services({ chunkTargetTokens: 120 }), {
      jobId: 'long',
    });
    const answer = await stack.ask('How often should sunscreen be reapplied?');
    const fromResource = answer.sources.filter((source) => source.resourceId.startsWith('701'));
    expect(fromResource.length).toBeLessThanOrEqual(3);
  });
});
