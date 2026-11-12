import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { createEndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 05: long content becomes several chunks that carry their position in the
 * course, so a citation can point a reader at the right place.
 */

function paragraphs(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `Step ${String(index + 1)}: clean the treatment area, check the client's notes and record the outcome in the file before continuing to the next stage of the protocol.`,
  );
}

describe('05 Chunking', () => {
  it('splits a long page into several chunks and keeps them in order', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Protocol',
      html: pageHtml('Protocol', paragraphs(40)),
    });
    await incrementalSync(await stack.harness.services({ chunkTargetTokens: 120 }), {
      jobId: 'chunking',
    });
    const chunks = [...stack.harness.documents().values()];
    expect(chunks.length).toBeGreaterThan(1);
    const numbers = chunks.map((chunk) => Number(chunk['chunkNumber'])).sort((a, b) => a - b);
    // 1-based, contiguous, and every chunk agrees on how many there are.
    expect(numbers).toEqual(Array.from({ length: chunks.length }, (_unused, index) => index + 1));
    expect(new Set(chunks.map((chunk) => Number(chunk['chunkCount'])))).toEqual(
      new Set([chunks.length]),
    );
  });

  it('keeps course, section and resource metadata on every chunk', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Protocol',
      html: pageHtml('Protocol', paragraphs(12)),
    });
    await incrementalSync(await stack.harness.services({ chunkTargetTokens: 120 }), {
      jobId: 'metadata',
    });
    for (const chunk of stack.harness.documents().values()) {
      expect(chunk).toMatchObject({
        courseId: 12,
        courseName: 'Chemical peels',
        resourceName: 'Protocol',
      });
      expect(String(chunk['resourceId'])).toMatch(/^701/);
      expect(String(chunk['sectionName']).length).toBeGreaterThan(0);
      expect(String(chunk['content']).length).toBeGreaterThan(0);
    }
  });

  it('indexes no empty chunk', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setPage(12, 701, {
      name: 'Short',
      html: pageHtml('Short', ['One short paragraph.', '', '   ']),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'empty' });
    for (const chunk of stack.harness.documents().values()) {
      expect(String(chunk['content']).trim().length).toBeGreaterThan(0);
    }
  });
});
