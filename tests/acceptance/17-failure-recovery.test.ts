import { MoodleAuthenticationError, MoodleTransportError } from '@ehub/moodle-client';
import { describe, expect, it } from 'vitest';

import { courseLeaseName } from '../../apps/indexer/src/state/syncState.js';
import { incrementalSync, retryFailedResources } from '../../apps/indexer/src/jobs/syncJobs.js';
import {
  FakeMoodleSite,
  TENANT_ID,
  pageHtml,
} from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { answerText, createEndToEndStack, type EndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 17: when Moodle, Azure or a previous run misbehaves, staff keep getting the
 * last good answer and the system recovers by itself. The failure mode to avoid is an outage
 * quietly emptying the index.
 */

const GUIDANCE = 'Wait fourteen days between superficial peels.';
const PAGE = 701;

async function seeded(): Promise<EndToEndStack> {
  const stack = await createEndToEndStack();
  stack.harness.site.addCourse(12, { name: 'Chemical peels' });
  stack.harness.site.setPage(12, PAGE, {
    name: 'Peel intervals',
    html: pageHtml('Intervals', [GUIDANCE]),
  });
  await incrementalSync(await stack.harness.services(), { jobId: 'seed' });
  return stack;
}

describe('17 Failure recovery', () => {
  it('keeps answering from the last good version while Moodle is unreachable', async () => {
    const stack = await seeded();
    stack.harness.clock.advance(3_600_000);
    stack.harness.site.setPage(12, PAGE, {
      name: 'Peel intervals',
      html: pageHtml('Intervals', ['Wait twenty-one days between superficial peels.']),
      timeModified: 1_771_000_000,
      revision: 2,
    });
    stack.harness.site.downloadErrors.set(
      FakeMoodleSite.pagePath(PAGE, 2),
      new MoodleTransportError('down', { code: 'timeout' }),
    );
    const services = await stack.harness.services();
    const failed = await incrementalSync(services, { jobId: 'outage' });
    expect(failed.resources[0]).toMatchObject({
      action: 'failed',
      failureCategory: 'moodle_unavailable',
    });
    expect(answerText(await stack.ask('How long between peels?'))).toContain('fourteen days');

    // Moodle comes back: an on-demand retry picks the resource up without operator surgery.
    stack.harness.site.downloadErrors.clear();
    const recovered = await retryFailedResources(services, { jobId: 'recover' });
    expect(recovered.resources[0]).toMatchObject({ action: 'indexed' });
    expect(answerText(await stack.ask('How long between peels?'))).toContain('twenty-one days');
  });

  it('fails one course and carries on with the rest', async () => {
    const stack = await createEndToEndStack();
    const { site } = stack.harness;
    site.addCourse(12, { name: 'Chemical peels' });
    site.addCourse(15, { name: 'Laser safety' });
    site.setPage(12, PAGE, { name: 'Intervals', html: pageHtml('Intervals', [GUIDANCE]) });
    site.setPage(15, 901, {
      name: 'Eyewear',
      html: pageHtml('Eyewear', ['Eye protection is mandatory during laser treatment.']),
    });
    site.contentErrors.set(12, new MoodleTransportError('down', { code: 'timeout' }));
    const report = await incrementalSync(
      await stack.harness.services({ settings: { courseIds: [12, 15] } }),
      { jobId: 'one-course-down' },
    );
    expect(report.status).toBe('completed_with_failures');
    expect(report.courses).toEqual([
      { courseId: 12, outcome: 'failed', failureCategory: 'moodle_unavailable' },
      { courseId: 15, outcome: 'synced' },
    ]);
    expect(
      answerText(await stack.ask('Is eye protection required?', { authorizedCourseIds: [15] })),
    ).toContain('Eye protection is mandatory');
  });

  it('leaves the old chunks searchable when the index rejects part of an upload', async () => {
    const stack = await seeded();
    stack.harness.clock.advance(3_600_000);
    stack.harness.site.setPage(12, PAGE, {
      name: 'Peel intervals',
      html: pageHtml('Intervals', ['Wait twenty-one days between superficial peels.']),
      timeModified: 1_771_000_000,
      revision: 2,
    });
    const [key] = [...stack.harness.documents().keys()];
    stack.harness.search.documentFailures.set(key ?? '', [400]);
    const report = await incrementalSync(await stack.harness.services(), { jobId: 'partial' });
    expect(report.resources[0]).toMatchObject({
      action: 'failed',
      failureCategory: 'index_partial_failure',
    });
    // A half-written resource would answer from two versions at once: nothing was replaced.
    expect(answerText(await stack.ask('How long between peels?'))).toContain('fourteen days');
  });

  it('stops on a rejected Moodle token without emptying the index, and recovers after it is fixed', async () => {
    const stack = await seeded();
    stack.harness.clock.advance(3_600_000);
    stack.harness.site.downloadErrors.set(
      FakeMoodleSite.pagePath(PAGE),
      new MoodleAuthenticationError('bad token', { code: 'invalidtoken' }),
    );
    stack.harness.site.setPage(12, PAGE, {
      name: 'Peel intervals',
      html: pageHtml('Intervals', [GUIDANCE]),
      timeModified: 1_771_000_000,
    });
    const services = await stack.harness.services();
    const report = await incrementalSync(services, { jobId: 'bad-token' });
    expect(report).toMatchObject({ status: 'failed', failureCategory: 'moodle_authentication' });
    expect(stack.harness.indexedResources().length).toBeGreaterThan(0);
    expect(answerText(await stack.ask('How long between peels?'))).toContain('fourteen days');

    // A job-wide failure must release its lease, or a bad token would block every later run.
    stack.harness.site.downloadErrors.clear();
    const next = await incrementalSync(services, { jobId: 'after-fix' });
    expect(next.status).toBe('succeeded');
  });

  it('takes over from a crashed job once its lease expires', async () => {
    const stack = await seeded();
    const services = await stack.harness.services();
    await stack.harness.state.acquireLease({
      name: courseLeaseName(TENANT_ID, 12),
      owner: 'crashed-job',
      ttlMs: 600_000,
    });
    const blocked = await incrementalSync(services, { jobId: 'while-locked' });
    expect(blocked.courses).toEqual([{ courseId: 12, outcome: 'locked' }]);

    stack.harness.clock.advance(601_000);
    const after = await incrementalSync(services, { jobId: 'after-expiry' });
    expect(after.courses).toEqual([{ courseId: 12, outcome: 'synced' }]);
  });

  it('still answers when the question cannot be embedded', async () => {
    const stack = await seeded();
    stack.harness.embeddings.scripted.push({ status: 500, body: '{"error":{"code":"Internal"}}' });
    const answer = await stack.ask('How long between peels?');
    // Failing closed: no sources, so no answer rather than an ungrounded one.
    expect(answer.status).not.toBe('answered');
    expect(answerText(answer)).not.toContain('fourteen days');
  });
});
