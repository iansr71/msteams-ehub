import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { pageHtml } from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { createEndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 02: only the selected, visible courses and activities are discovered. What
 * is discovered decides what can ever be answered, so this is an access-control boundary as
 * much as a content one.
 */

async function stackWithCourses() {
  const stack = await createEndToEndStack();
  const { site } = stack.harness;
  site.addCourse(12, { name: 'Chemical peels' });
  site.addCourse(13, { name: 'Laser safety' });
  site.addCourse(14, { name: 'Hidden course', visible: false });
  site.setPage(12, 701, { name: 'Aftercare', html: pageHtml('Aftercare', ['Selected course.']) });
  site.setPage(13, 801, { name: 'Eyewear', html: pageHtml('Eyewear', ['Other course.']) });
  site.setPage(14, 901, { name: 'Draft', html: pageHtml('Draft', ['Hidden course.']) });
  return stack;
}

describe('02 Course discovery', () => {
  it('indexes the selected courses and nothing else', async () => {
    const stack = await stackWithCourses();
    const report = await incrementalSync(
      await stack.harness.services({ settings: { courseIds: [12, 13] } }),
      { jobId: 'discovery' },
    );
    expect(report.status).toBe('succeeded');
    expect(report.courses.map((course) => course.courseId).sort()).toEqual([12, 13]);
    const indexed = stack.harness.indexedResources();
    expect(indexed.some((id) => id.startsWith('701'))).toBe(true);
    expect(indexed.some((id) => id.startsWith('801'))).toBe(true);
    expect(indexed.some((id) => id.startsWith('901'))).toBe(false);
  });

  it('skips a hidden course even when it is selected', async () => {
    const stack = await stackWithCourses();
    const report = await incrementalSync(
      await stack.harness.services({ settings: { courseIds: [14] } }),
      { jobId: 'hidden-course' },
    );
    expect(stack.harness.indexedResources()).toEqual([]);
    expect(report.courses[0]).toMatchObject({ courseId: 14 });
  });

  it('skips a hidden activity inside a selected course', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Visible',
      html: pageHtml('Visible', ['Visible page.']),
    });
    stack.harness.site.setPage(12, 702, {
      name: 'Hidden',
      html: pageHtml('Hidden', ['Hidden page.']),
      visible: false,
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'hidden-activity' });
    const indexed = stack.harness.indexedResources();
    expect(indexed.some((id) => id.startsWith('701'))).toBe(true);
    expect(indexed.some((id) => id.startsWith('702'))).toBe(false);
  });

  it('records course and resource identifiers, never document text', async () => {
    const stack = await stackWithCourses();
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'metadata' });
    expect(JSON.stringify(report)).not.toContain('Selected course.');
    expect(report.resources.every((resource) => resource.resourceId.length > 0)).toBe(true);
  });
});
