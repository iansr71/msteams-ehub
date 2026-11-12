import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { contentUpdateCaseFileSchema, loadDataset } from './framework/datasets.js';
import { answerText, createEndToEndStack } from './framework/endToEnd.js';

/*
 * The end-to-end content-update test Prompt 18 requires, driven by
 * tests/evaluation/content-update-cases.json: index version 1, answer from it, replace the
 * source, re-sync incrementally, prove the old chunks are gone, and answer from version 2.
 *
 * This is the test that proves the whole chain rather than any one stage: a question's answer
 * comes from what the pipeline indexed, so if cleanup or change detection breaks, staff would
 * be quoted withdrawn guidance and this fails.
 */

const cases = loadDataset('content-update-cases.json', contentUpdateCaseFileSchema);

describe('19 Content update, end to end', () => {
  for (const testCase of cases) {
    it(`replaces answers for ${testCase.id}`, async () => {
      const stack = await createEndToEndStack();
      const { site, harness } = { site: stack.harness.site, harness: stack.harness };
      site.addCourse(testCase.courseId, { name: `Course ${String(testCase.courseId)}` });
      site.setPage(testCase.courseId, testCase.moduleId, {
        name: 'Procedure',
        html: pageHtml('Procedure', testCase.before),
      });
      const services = await harness.services({
        settings: { courseIds: [testCase.courseId] },
      });

      // 1. Index version 1.
      const first = await incrementalSync(services, { jobId: `${testCase.id}-v1` });
      expect(first.counts.updated).toBe(1);
      const v1Hashes = [...harness.documents().values()].map((document) =>
        String(document['contentHash']),
      );
      expect(v1Hashes.length).toBeGreaterThan(0);

      // 2. Version 1 answers the question, and version 2's wording is nowhere yet.
      const before = answerText(
        await stack.ask(testCase.question, { authorizedCourseIds: [testCase.courseId] }),
      );
      for (const fact of testCase.beforeFacts) {
        expect(before.toLowerCase()).toContain(fact.toLowerCase());
      }
      for (const fact of testCase.afterFacts) {
        expect(before.toLowerCase()).not.toContain(fact.toLowerCase());
      }

      // 3. Replace the source content.
      harness.clock.advance(3_600_000);
      site.setPage(testCase.courseId, testCase.moduleId, {
        name: 'Procedure',
        html: pageHtml('Procedure', testCase.after),
        timeModified: 1_771_000_000,
        revision: 2,
      });

      // 4. Incremental sync picks the change up.
      const second = await incrementalSync(services, { jobId: `${testCase.id}-v2` });
      expect(second.counts.updated).toBe(1);

      // 5. The version 1 chunks are gone, not merely outranked. Chunk keys are stable, so the
      // proof is that no document still carries a version 1 body (by hash and by wording).
      const remainingHashes = new Set(
        [...harness.documents().values()].map((document) => String(document['contentHash'])),
      );
      expect(v1Hashes.some((hash) => remainingHashes.has(hash))).toBe(false);
      const indexedText = [...harness.documents().values()]
        .map((document) => (typeof document['content'] === 'string' ? document['content'] : ''))
        .join('\n')
        .toLowerCase();
      for (const fact of testCase.beforeFacts) {
        expect(indexedText).not.toContain(fact.toLowerCase());
      }

      // 6 and 7. The answer is now version 2, with no trace of version 1.
      const after = answerText(
        await stack.ask(testCase.question, { authorizedCourseIds: [testCase.courseId] }),
      );
      for (const fact of testCase.afterFacts) {
        expect(after.toLowerCase()).toContain(fact.toLowerCase());
      }
      for (const fact of testCase.beforeFacts) {
        expect(after.toLowerCase()).not.toContain(fact.toLowerCase());
      }
    });
  }
});
