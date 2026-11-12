import { describe, expect, it } from 'vitest';

import {
  deleteStaleResources,
  fullSync,
  incrementalSync,
} from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { answerText, createEndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 15: content removed or hidden in Moodle stops being answerable. Staff must
 * not be given withdrawn guidance, so this is a correctness and a safety requirement.
 */

const PEEL = 'Reapply broad-spectrum sunscreen every two hours after a chemical peel.';
const WITHDRAWN = 'Withdrawn guidance: no sunscreen is needed after a superficial peel.';

async function stackWithTwoPages() {
  const stack = await createEndToEndStack();
  stack.harness.site.addCourse(12, { name: 'Chemical peels' });
  stack.harness.site.setPage(12, 701, { name: 'Aftercare', html: pageHtml('Aftercare', [PEEL]) });
  stack.harness.site.setPage(12, 702, {
    name: 'Old leaflet',
    html: pageHtml('Old leaflet', [WITHDRAWN]),
  });
  const services = await stack.harness.services();
  await incrementalSync(services, { jobId: 'seed' });
  expect(stack.harness.indexedResources().some((id) => id.startsWith('702'))).toBe(true);
  return { stack, services };
}

describe('15 Deleted-content cleanup', () => {
  it('removes an activity deleted in Moodle, and stops answering from it', async () => {
    const { stack, services } = await stackWithTwoPages();
    stack.harness.clock.advance(60_000);
    stack.harness.site.removeModule(12, 702);
    const report = await fullSync(services, { jobId: 'after-delete' });
    expect(report.breakdown.removed).toBeGreaterThan(0);
    expect(stack.harness.indexedResources().some((id) => id.startsWith('702'))).toBe(false);

    const answer = await stack.ask('Is sunscreen needed after a superficial peel?');
    expect(answerText(answer)).not.toContain('Withdrawn guidance');
  });

  it('removes an activity that was hidden rather than deleted', async () => {
    const { stack, services } = await stackWithTwoPages();
    stack.harness.clock.advance(60_000);
    stack.harness.site.setPage(12, 702, {
      name: 'Old leaflet',
      html: pageHtml('Old leaflet', [WITHDRAWN]),
      visible: false,
      revision: 2,
    });
    await fullSync(services, { jobId: 'after-hide' });
    expect(stack.harness.indexedResources().some((id) => id.startsWith('702'))).toBe(false);
  });

  it('removes a whole course that left the selection', async () => {
    const stack = await createEndToEndStack();
    const { site } = stack.harness;
    site.addCourse(12, { name: 'Chemical peels' });
    site.addCourse(13, { name: 'Laser safety' });
    site.setPage(12, 701, { name: 'Aftercare', html: pageHtml('Aftercare', [PEEL]) });
    site.setPage(13, 801, {
      name: 'Eyewear',
      html: pageHtml('Eyewear', ['Wear wavelength-specific eyewear during laser treatment.']),
    });
    await incrementalSync(await stack.harness.services({ settings: { courseIds: [12, 13] } }), {
      jobId: 'both',
    });
    expect(stack.harness.indexedResources().some((id) => id.startsWith('701'))).toBe(true);

    // Course 12 is dropped from SYNC_COURSE_IDS: reconciliation clears what it left behind.
    stack.harness.clock.advance(60_000);
    const narrowed = await stack.harness.services({
      settings: { courseIds: [13], maxDeleteFraction: 1, maxDeleteMinimum: 100 },
    });
    await deleteStaleResources(narrowed, { jobId: 'course-gone' });
    const indexed = stack.harness.indexedResources();
    expect(indexed.some((id) => id.startsWith('701'))).toBe(false);
    expect(indexed.some((id) => id.startsWith('801'))).toBe(true);
  });

  it('refuses to reconcile with no courses selected at all', async () => {
    const { stack } = await stackWithTwoPages();
    const empty = await stack.harness.services({ settings: { courseIds: [] } });
    // A guard against emptying the index through a misconfiguration.
    await expect(deleteStaleResources(empty, { jobId: 'no-selection' })).rejects.toThrow();
    expect(stack.harness.indexedResources().length).toBeGreaterThan(0);
  });

  it('refuses a deletion that would remove too much at once', async () => {
    const { stack } = await stackWithTwoPages();
    stack.harness.clock.advance(60_000);
    stack.harness.site.clearCourse(12);
    const guarded = await stack.harness.services({
      settings: { maxDeleteFraction: 0.1, maxDeleteMinimum: 1 },
    });
    const report = await fullSync(guarded, { jobId: 'guarded' });
    // The guard stops a mass deletion (a Moodle outage returning an empty course, say) and
    // says why, rather than emptying the index.
    expect(report.warnings.join(' ') + (report.failureCategory ?? '')).toMatch(
      /delete|guard|threshold|limit/i,
    );
    expect(stack.harness.indexedResources().length).toBeGreaterThan(0);
  });
});
