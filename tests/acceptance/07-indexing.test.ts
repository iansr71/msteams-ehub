import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { TENANT_ID } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { createEndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 07: chunks reach the search index with the fields retrieval and citations
 * depend on, and a re-index replaces a resource's chunks instead of adding to them.
 */

describe('07 Indexing', () => {
  it('indexes every chunk under the tenant with the fields retrieval needs', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', ['Reapply sunscreen every two hours after a peel.']),
    });
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'index' });
    expect(report.counts.updated).toBeGreaterThan(0);
    expect(report.breakdown.indexed).toBeGreaterThan(0);
    for (const chunk of stack.harness.documents().values()) {
      expect(chunk).toMatchObject({ tenantId: TENANT_ID, courseId: 12, isActive: true });
      for (const field of ['id', 'resourceId', 'moduleId', 'content', 'indexedAt', 'title']) {
        expect(chunk[field], field).toBeDefined();
      }
    }
  });

  it('replaces a resource’s chunks on re-index rather than adding to them', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setPage(12, 701, {
      name: 'Protocol',
      html: pageHtml(
        'Protocol',
        Array.from(
          { length: 40 },
          (_unused, index) =>
            `Step ${String(index + 1)}: prepare the room, check the client file, apply the solution evenly, time the application and record the outcome before the next stage.`,
        ),
      ),
    });
    const services = await stack.harness.services({ chunkTargetTokens: 120 });
    await incrementalSync(services, { jobId: 'first' });
    const firstCount = stack.harness.documents().size;
    expect(firstCount).toBeGreaterThan(1);

    stack.harness.clock.advance(60_000);
    stack.harness.site.setPage(12, 701, {
      name: 'Protocol',
      html: pageHtml('Protocol', ['Step one only: prepare the room and check the client file.']),
      revision: 2,
    });
    const report = await incrementalSync(services, { jobId: 'second' });
    expect(report.resources.some((resource) => (resource.staleChunksRemoved ?? 0) > 0)).toBe(true);
    expect(stack.harness.documents().size).toBeLessThan(firstCount);
    const content = [...stack.harness.documents().values()]
      .map((chunk) => String(chunk['content']))
      .join('\n');
    expect(content).toContain('Step one only');
    expect(content).not.toContain('Step 12');
  });

  it('keeps courses apart in the index', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.addCourse(13, { name: 'Laser safety' });
    stack.harness.site.setPage(12, 701, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', ['Peel content.']),
    });
    stack.harness.site.setPage(13, 801, {
      name: 'Eyewear',
      html: pageHtml('Eyewear', ['Laser content.']),
    });
    await incrementalSync(await stack.harness.services({ settings: { courseIds: [12, 13] } }), {
      jobId: 'two-courses',
    });
    const byCourse = new Map<number, string[]>();
    for (const chunk of stack.harness.documents().values()) {
      const course = Number(chunk['courseId']);
      byCourse.set(course, [...(byCourse.get(course) ?? []), String(chunk['content'])]);
    }
    expect(byCourse.get(12)?.join(' ')).toContain('Peel content');
    expect(byCourse.get(12)?.join(' ')).not.toContain('Laser content');
    expect(byCourse.get(13)?.join(' ')).toContain('Laser content');
  });
});
