import { describe, expect, it } from 'vitest';

import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import { loadBinary } from '../../apps/indexer/src/extractors/__fixtures__/helpers.js';
import { createEndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 03: course files are fetched from Moodle's file endpoint, with the token, and
 * a file that cannot be fetched fails that resource only.
 */

describe('03 File downloading', () => {
  it('downloads a course file and indexes its text', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setFile(12, 702, {
      fileName: 'Aftercare.pdf',
      bytes: loadBinary('sample.pdf'),
      mimeType: 'application/pdf',
    });
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'download' });
    expect(report.status).toBe('succeeded');
    expect(stack.harness.site.downloads.length).toBeGreaterThan(0);
    expect(stack.harness.indexedResources().some((id) => id.startsWith('702'))).toBe(true);
  });

  // The fake records request paths only. That the host must be the configured Moodle site, and
  // that redirects elsewhere are refused, is tested against the real downloader in
  // tests/security/attacks/ssrf-and-resource-urls.test.ts (controls SSRF-1, SSRF-2).
  it('requests only Moodle file endpoints', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, {});
    stack.harness.site.setFile(12, 702, {
      fileName: 'Aftercare.pdf',
      bytes: loadBinary('sample.pdf'),
      mimeType: 'application/pdf',
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'urls' });
    expect(stack.harness.site.downloads.length).toBeGreaterThan(0);
    for (const path of stack.harness.site.downloads) {
      expect(path).toMatch(/\/(?:webservice\/)?pluginfile\.php\//);
    }
  });

  it('fails one resource without stopping the job when a download fails', async () => {
    const stack = await createEndToEndStack();
    const { site } = stack.harness;
    site.addCourse(12, {});
    site.setFile(12, 702, {
      fileName: 'Good.pdf',
      bytes: loadBinary('sample.pdf'),
      mimeType: 'application/pdf',
    });
    site.setFile(12, 703, {
      fileName: 'Broken.pdf',
      bytes: loadBinary('sample.pdf'),
      mimeType: 'application/pdf',
    });
    const broken = [...site.files.keys()].find((key) => key.includes('Broken'));
    if (broken === undefined) {
      throw new Error('fixture: the file was not registered');
    }
    site.downloadErrors.set(broken, new Error('network down'));
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'partial' });
    expect(report.status).toBe('completed_with_failures');
    expect(stack.harness.indexedResources().some((id) => id.startsWith('702'))).toBe(true);
    const failed = report.resources.filter((resource) => resource.action === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failureCategory).toBeDefined();
  });
});
