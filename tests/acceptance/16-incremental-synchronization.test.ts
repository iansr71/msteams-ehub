import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { answerText, createEndToEndStack, type EndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 16: a scheduled run must be cheap when nothing changed and must pick up what
 * did. Cheap matters because every re-index costs embedding calls; correct matters because stale
 * guidance is the failure staff would notice.
 */

const V1 = 'Wait fourteen days between superficial peels.';
const V2 = 'Wait twenty-one days between superficial peels.';

async function seeded(): Promise<EndToEndStack> {
  const stack = await createEndToEndStack();
  stack.harness.site.addCourse(12, { name: 'Chemical peels' });
  stack.harness.site.setPage(12, 701, {
    name: 'Peel intervals',
    html: pageHtml('Intervals', [V1]),
  });
  await incrementalSync(await stack.harness.services(), { jobId: 'seed' });
  return stack;
}

/** Embedding requests so far: the cost of a run. */
function embeddingCalls(stack: EndToEndStack): number {
  return stack.harness.embeddings.requests.length;
}

describe('16 Incremental synchronization', () => {
  it('skips unchanged content and spends nothing on embeddings', async () => {
    const stack = await seeded();
    const before = embeddingCalls(stack);
    stack.harness.clock.advance(3_600_000);
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'no-change' });
    expect(report.counts.updated).toBe(0);
    expect(report.counts.skipped).toBeGreaterThan(0);
    expect(embeddingCalls(stack)).toBe(before);
  });

  it('re-indexes a changed page, and the answer changes with it', async () => {
    const stack = await seeded();
    expect(answerText(await stack.ask('How long between peels?'))).toContain('fourteen days');

    stack.harness.clock.advance(3_600_000);
    stack.harness.site.setPage(12, 701, {
      name: 'Peel intervals',
      html: pageHtml('Intervals', [V2]),
      timeModified: 1_771_000_000,
      revision: 2,
    });
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'changed' });
    expect(report.counts.updated).toBe(1);

    const after = answerText(await stack.ask('How long between peels?'));
    expect(after).toContain('twenty-one days');
    expect(after).not.toContain('fourteen days');
  });

  it('picks up a new activity without re-indexing the rest', async () => {
    const stack = await seeded();
    stack.harness.clock.advance(3_600_000);
    stack.harness.site.setPage(12, 702, {
      name: 'Patch testing',
      html: pageHtml('Patch testing', ['Patch test every client forty-eight hours beforehand.']),
    });
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'added' });
    expect(report.counts.updated).toBe(1);
    expect(report.resources.filter((entry) => entry.action === 'skipped')).toHaveLength(1);
    expect(answerText(await stack.ask('When should a patch test happen?'))).toContain(
      'forty-eight hours',
    );
  });

  it('re-indexes everything when the embedding version changes', async () => {
    const stack = await seeded();
    stack.harness.clock.advance(3_600_000);
    // A new embedding model makes existing vectors incomparable, so the fingerprint must change.
    const report = await incrementalSync(await stack.harness.services({ embeddingVersion: '2' }), {
      jobId: 'reembed',
    });
    expect(report.counts.updated).toBe(1);
    expect(report.resources[0]?.reasons).toContain('embedding_changed');
  });

  it('is idempotent: running twice leaves one copy of each chunk', async () => {
    const stack = await seeded();
    const keys = [...stack.harness.documents().keys()].sort();
    stack.harness.clock.advance(3_600_000);
    await incrementalSync(await stack.harness.services(), { jobId: 'again' });
    expect([...stack.harness.documents().keys()].sort()).toEqual(keys);
  });
});
