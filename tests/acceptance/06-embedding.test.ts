import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { HARNESS_AZURE } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { createEndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 06: every indexed chunk carries a vector of the configured size, stamped with
 * the model that produced it, and unchanged content is not embedded again (embeddings cost money).
 */

describe('06 Embedding', () => {
  it('stores one vector of the configured size per chunk, with its model stamp', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', ['Reapply sunscreen every two hours after a peel.']),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'embed' });
    const chunks = [...stack.harness.documents().values()];
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const vector = chunk['contentVector'];
      expect(Array.isArray(vector)).toBe(true);
      expect((vector as number[]).length).toBe(HARNESS_AZURE.dimensions);
      expect(chunk['embeddingDimensions']).toBe(HARNESS_AZURE.dimensions);
      expect(chunk['embeddingModel']).toBe(HARNESS_AZURE.embeddingModel);
      expect(String(chunk['embeddingVersion']).length).toBeGreaterThan(0);
    }
  });

  it('does not embed unchanged content again', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', ['Reapply sunscreen every two hours after a peel.']),
    });
    const services = await stack.harness.services();
    const first = await incrementalSync(services, { jobId: 'embed-1' });
    const generated = first.resources.reduce(
      (total, resource) => total + (resource.embeddings?.generated ?? 0),
      0,
    );
    expect(generated).toBeGreaterThan(0);

    const second = await incrementalSync(services, { jobId: 'embed-2' });
    expect(second.resources.every((resource) => resource.action === 'skipped')).toBe(true);
    expect(
      second.resources.reduce(
        (total, resource) => total + (resource.embeddings?.generated ?? 0),
        0,
      ),
    ).toBe(0);
  });

  it('re-embeds a resource whose text changed', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', ['Reapply sunscreen every two hours after a peel.']),
    });
    const services = await stack.harness.services();
    await incrementalSync(services, { jobId: 'change-1' });
    const before = [...stack.harness.documents().values()].map((chunk) => chunk['contentHash']);

    stack.harness.clock.advance(60_000);
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', ['Reapply sunscreen every ninety minutes after a peel.']),
      revision: 2,
    });
    const report = await incrementalSync(services, { jobId: 'change-2' });
    expect(report.resources.some((resource) => resource.action === 'indexed')).toBe(true);
    const after = [...stack.harness.documents().values()].map((chunk) => chunk['contentHash']);
    expect(after).not.toEqual(before);
  });
});
