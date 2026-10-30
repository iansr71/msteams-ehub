import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MoodleAuthenticationError, MoodleTransportError } from '@ehub/moodle-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadBinary } from '../extractors/__fixtures__/helpers.js';
import { pdfExtractor } from '../extractors/pdfExtractor.js';
import { ResourceNotFoundError } from '../moodle/inspectCourse.js';
import { FileSyncStateRepository } from '../state/fileSyncStateRepository.js';
import { courseLeaseName } from '../state/syncState.js';
import {
  FakeMoodleSite,
  TENANT_ID,
  createHarness,
  pageHtml,
  type Harness,
} from './__fixtures__/syncHarness.js';
import { SyncSelectionError } from './syncContext.js';
import {
  deleteStaleResources,
  fullSync,
  incrementalSync,
  retryFailedResources,
  syncCourse,
  syncResource,
} from './syncJobs.js';
import { renderSyncReportText, type SyncReport } from './syncReport.js';

const SECRET = 'Zebra-orchid protocol requires SPF 50 reapplied every ninety minutes';
const PAGE = '601:page';
const PDF = '702:file:/Aftercare.pdf';

function longParagraphs(seed: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `${seed} paragraph ${String(index + 1)}: ${'Clients receive written aftercare covering cleansing, hydration, sun protection and follow-up booking. '.repeat(6)}`,
  );
}

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  h.site.addCourse(12, { name: 'Consultation Standards' });
  h.site.setPage(12, 601, {
    name: 'Peel aftercare',
    html: pageHtml('Peel aftercare', [SECRET, 'Avoid exfoliating products for seven days.']),
  });
  h.site.setFile(12, 702, {
    fileName: 'Aftercare.pdf',
    bytes: loadBinary('sample.pdf'),
    mimeType: 'application/pdf',
  });
});

function entry(report: SyncReport, resourceId: string) {
  return report.resources.find((resource) => resource.resourceId === resourceId);
}

async function state(resourceId: string, courseId = 12) {
  return h.state.getResource({ tenantId: TENANT_ID, courseId, resourceId });
}

function expectNoContent(report: SyncReport): void {
  const text = `${JSON.stringify(report)}\n${renderSyncReportText(report, { verbose: true })}\n${h.logs.join('\n')}`;
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('Zebra-orchid');
}

describe('incremental sync', () => {
  it('indexes new HTML pages and PDFs, then skips them when nothing changed', async () => {
    const services = await h.services();
    const first = await incrementalSync(services, { jobId: 'job-1' });
    expect(first.status).toBe('succeeded');
    expect(first.counts).toEqual({ processed: 2, skipped: 0, updated: 2, removed: 0, failed: 0 });
    expect(entry(first, PAGE)).toMatchObject({ action: 'indexed', reasons: ['new'] });
    expect(entry(first, PDF)).toMatchObject({ action: 'indexed', reasons: ['new'] });
    expect(h.indexedResources()).toEqual([PAGE, PDF]);

    const pageChunk = [...h.documents().values()].find((doc) => doc['resourceId'] === PAGE);
    expect(pageChunk).toMatchObject({
      tenantId: TENANT_ID,
      courseId: 12,
      courseName: 'Consultation Standards',
      sectionName: 'General',
      moduleName: 'Peel aftercare',
      moduleUrl: 'https://ehub.example.test/mod/page/view.php?id=601',
      resourceType: 'moodle-page',
      isActive: true,
      embeddingModel: 'text-embedding-3-small',
    });
    const pdfChunk = [...h.documents().values()].find((doc) => doc['resourceId'] === PDF);
    expect(pdfChunk?.['pageNumber']).toBe(1);

    expect(await state(PAGE)).toMatchObject({
      status: 'indexed',
      retryCount: 0,
      lastJobId: 'job-1',
      lastJobType: 'incremental',
      lastSuccessfulIndexAt: '2026-03-02T06:00:00.000Z',
      indexed: {
        moodleModifiedAt: new Date(1_770_000_000_000).toISOString(),
        extractorVersion: expect.stringMatching(/@/) as unknown,
        chunkerVersion: services.versions.chunker,
        embeddingModel: 'text-embedding-3-small',
        embeddingVersion: '1',
      },
    });
    expect(await h.state.getJob('job-1')).toMatchObject({
      status: 'succeeded',
      jobType: 'incremental',
      finishedAt: '2026-03-02T06:00:00.000Z',
      counts: first.counts,
      courseIds: [12],
    });

    const downloads = h.site.downloads.length;
    const searchRequests = h.search.requests.length;
    const embeddingRequests = h.embeddings.requests.length;
    const second = await incrementalSync(services, { jobId: 'job-2' });
    expect(second.counts).toEqual({ processed: 2, skipped: 2, updated: 0, removed: 0, failed: 0 });
    expect(entry(second, PAGE)).toMatchObject({ action: 'skipped', reasons: ['unchanged'] });
    expect(h.site.downloads).toHaveLength(downloads);
    expect(h.search.requests).toHaveLength(searchRequests);
    expect(h.embeddings.requests).toHaveLength(embeddingRequests);
    expectNoContent(second);
    expectNoContent(first);
  });

  it('skips re-indexing when Moodle reports a change but the file is identical', async () => {
    const services = await h.services();
    await incrementalSync(services);
    const uploads = () =>
      h.search.requests.filter((request) => request.path.endsWith('/docs/index')).length;
    const before = uploads();
    h.site.setPage(12, 601, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', [SECRET, 'Avoid exfoliating products for seven days.']),
      timeModified: 1_770_500_000,
    });
    const report = await incrementalSync(services);
    expect(entry(report, PAGE)).toMatchObject({
      action: 'skipped',
      reasons: ['content_unchanged'],
    });
    expect(uploads()).toBe(before);
    const downloads = h.site.downloads.length;
    expect(entry(await incrementalSync(services), PAGE)).toMatchObject({ reasons: ['unchanged'] });
    expect(h.site.downloads).toHaveLength(downloads);
  });

  it('replaces changed content, uploading before removing leftover chunks', async () => {
    h.site.setPage(12, 601, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', longParagraphs('Long', 12)),
    });
    const services = await h.services();
    await incrementalSync(services);
    const before = [...h.documents().values()].filter((doc) => doc['resourceId'] === PAGE).length;
    expect(before).toBeGreaterThan(1);

    h.site.setPage(12, 601, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', ['Short replacement text about sunscreen.']),
      timeModified: 1_771_000_000,
      revision: 2,
    });
    const requestStart = h.search.requests.length;
    const report = await incrementalSync(services);
    expect(entry(report, PAGE)).toMatchObject({
      action: 'indexed',
      chunks: 1,
      staleChunksRemoved: before - 1,
    });
    const pageDocs = [...h.documents().values()].filter((doc) => doc['resourceId'] === PAGE);
    expect(pageDocs).toHaveLength(1);
    expect(String(pageDocs[0]?.['content'])).toContain('Short replacement');

    const actions = h.search.requests
      .slice(requestStart)
      .filter((request) => request.path.endsWith('/docs/index'))
      .map(
        (request) =>
          (JSON.parse(request.body) as { value: { '@search.action': string }[] }).value[0]?.[
            '@search.action'
          ],
      );
    expect(actions).toEqual(['upload', 'delete']);
  });

  it('reprocesses when the chunker settings, embedding version or an extractor change', async () => {
    await incrementalSync(await h.services());

    const chunker = await incrementalSync(await h.services({ chunkTargetTokens: 300 }));
    expect(entry(chunker, PAGE)?.reasons).toEqual(['chunker_changed']);
    expect(chunker.counts.updated).toBe(2);

    const embedding = await incrementalSync(
      await h.services({ chunkTargetTokens: 300, embeddingVersion: '2' }),
    );
    expect(entry(embedding, PDF)?.reasons).toEqual(['embedding_changed']);
    expect([...h.documents().values()].every((doc) => doc['embeddingVersion'] === '2')).toBe(true);

    const extractor = await incrementalSync(
      await h.services({
        chunkTargetTokens: 300,
        embeddingVersion: '2',
        extractorVersionBump: pdfExtractor.name,
      }),
    );
    expect(entry(extractor, PDF)).toMatchObject({
      action: 'indexed',
      reasons: ['extractor_changed'],
    });
    expect(entry(extractor, PAGE)).toMatchObject({ action: 'skipped' });
  });

  it('removes deleted and hidden resources and indexes them again when they return', async () => {
    const services = await h.services();
    await incrementalSync(services);
    h.site.removeModule(12, 702);
    h.site.setPage(12, 601, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', [SECRET]),
      visible: false,
    });
    const report = await incrementalSync(services);
    expect(entry(report, PDF)).toMatchObject({ action: 'removed', reasons: ['deleted'] });
    expect(entry(report, PAGE)).toMatchObject({ action: 'excluded', reasons: ['hidden'] });
    expect(report.counts.removed).toBe(2);
    expect(h.indexedResources()).toEqual([]);
    expect(await state(PDF)).toMatchObject({ status: 'removed', statusReason: 'deleted' });
    expect((await state(PDF))?.indexed).toBeUndefined();

    // Recorded once; not repeated on the next run.
    const again = await incrementalSync(services);
    expect(entry(again, PAGE)).toMatchObject({ action: 'skipped', reasons: ['already_excluded'] });
    expect(entry(again, PDF)).toBeUndefined();

    h.site.setFile(12, 702, {
      fileName: 'Aftercare.pdf',
      bytes: loadBinary('sample.pdf'),
      mimeType: 'application/pdf',
    });
    h.site.setPage(12, 601, { name: 'Peel aftercare', html: pageHtml('Peel aftercare', [SECRET]) });
    const back = await incrementalSync(services);
    expect(back.counts.updated).toBe(2);
    expect(h.indexedResources()).toEqual([PAGE, PDF]);
  });

  it('indexes hidden content only when configured to', async () => {
    h.site.setCourseVisible(12, false);
    expect((await incrementalSync(await h.services())).counts).toMatchObject({
      updated: 0,
      skipped: 2,
    });
    expect(
      (await incrementalSync(await h.services({ settings: { includeHidden: true } }))).counts
        .updated,
    ).toBe(2);
  });
});

describe('failures', () => {
  it('quarantines permanent extraction failures and retries them only when the file changes', async () => {
    h.site.setFile(12, 702, {
      fileName: 'Aftercare.pdf',
      bytes: loadBinary('encrypted.pdf'),
      mimeType: 'application/pdf',
    });
    const services = await h.services();
    const first = await incrementalSync(services);
    expect(entry(first, PDF)).toMatchObject({
      action: 'quarantined',
      failureCategory: 'encrypted',
    });
    expect(first.status).toBe('completed_with_failures');
    expect(await state(PDF)).toMatchObject({
      status: 'quarantined',
      failureCategory: 'encrypted',
      retryCount: 0,
    });

    const downloads = h.site.downloads.length;
    expect(entry(await incrementalSync(services), PDF)).toMatchObject({ reasons: ['quarantined'] });
    expect(entry(await retryFailedResources(services), PDF)).toBeUndefined();
    expect(h.site.downloads).toHaveLength(downloads);

    h.site.setFile(12, 702, {
      fileName: 'Aftercare.pdf',
      bytes: loadBinary('sample.pdf'),
      mimeType: 'application/pdf',
      timeModified: 1_771_000_000,
      revision: 2,
    });
    expect(entry(await incrementalSync(services), PDF)).toMatchObject({ action: 'indexed' });
  });

  it('keeps old chunks when a changed file fails transiently, removes them when it fails permanently', async () => {
    const services = await h.services();
    await incrementalSync(services);
    const path = FakeMoodleSite.filePath(702, 'Aftercare.pdf', 2);
    h.site.setFile(12, 702, {
      fileName: 'Aftercare.pdf',
      bytes: loadBinary('encrypted.pdf'),
      mimeType: 'application/pdf',
      timeModified: 1_771_000_000,
      revision: 2,
    });
    h.site.downloadErrors.set(path, new MoodleTransportError('down', { code: 'timeout' }));
    const transient = await incrementalSync(services);
    expect(entry(transient, PDF)).toMatchObject({
      action: 'failed',
      failureCategory: 'moodle_unavailable',
      retryCount: 1,
    });
    expect(h.indexedResources()).toContain(PDF);

    h.site.downloadErrors.delete(path);
    const permanent = await retryFailedResources(services);
    expect(entry(permanent, PDF)).toMatchObject({
      action: 'quarantined',
      failureCategory: 'encrypted',
    });
    expect(entry(permanent, PDF)?.chunksRemoved).toBeGreaterThan(0);
    expect(h.indexedResources()).toEqual([PAGE]);
  });

  it('backs off transient failures, retries on demand and dead-letters after the limit', async () => {
    const path = FakeMoodleSite.filePath(702, 'Aftercare.pdf');
    h.site.downloadErrors.set(path, new MoodleTransportError('down', { code: 'timeout' }));
    const services = await h.services();
    await incrementalSync(services);
    expect(await state(PDF)).toMatchObject({
      status: 'failed',
      retryCount: 1,
      nextRetryAt: '2026-03-02T06:10:00.000Z',
    });

    // Not due yet: incremental leaves it alone.
    expect(entry(await incrementalSync(services), PDF)).toMatchObject({
      reasons: ['retry_not_due'],
    });
    h.clock.advance(11 * 60_000);
    expect(entry(await incrementalSync(services), PDF)).toMatchObject({
      action: 'failed',
      retryCount: 2,
    });

    // retry-failed ignores the backoff; the third failure dead-letters (SYNC_MAX_ATTEMPTS=3).
    const third = await retryFailedResources(services);
    expect(entry(third, PDF)).toMatchObject({ action: 'dead_letter', retryCount: 3 });
    expect((await state(PDF))?.nextRetryAt).toBeUndefined();

    h.site.downloadErrors.delete(path);
    expect(entry(await retryFailedResources(services), PDF)).toBeUndefined();
    expect(entry(await incrementalSync(services), PDF)).toMatchObject({ reasons: ['dead_letter'] });
    const operator = await retryFailedResources(services, { includeDeadLetter: true });
    expect(entry(operator, PDF)).toMatchObject({ action: 'indexed', reasons: ['operator_retry'] });
    expect(await state(PDF)).toMatchObject({ status: 'indexed', retryCount: 0 });
  });

  it('keeps the old chunks searchable when the index rejects part of an upload', async () => {
    h.site.setPage(12, 601, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', longParagraphs('Old', 12)),
    });
    const services = await h.services();
    await incrementalSync(services);
    const oldKeys = [...h.documents().keys()];
    h.site.setPage(12, 601, {
      name: 'Peel aftercare',
      html: pageHtml('Peel aftercare', longParagraphs('New', 3)),
      timeModified: 1_771_000_000,
      revision: 2,
    });
    const pageKeys = [...h.documents().entries()]
      .filter(([, doc]) => doc['resourceId'] === PAGE)
      .map(([key]) => key);
    h.search.documentFailures.set(pageKeys[0] ?? '', [400]);
    const report = await incrementalSync(services);
    expect(entry(report, PAGE)).toMatchObject({
      action: 'failed',
      failureCategory: 'index_partial_failure',
    });
    // Nothing was deleted: every old key still exists.
    expect(oldKeys.every((key) => h.documents().has(key))).toBe(true);
    expect((await state(PAGE))?.indexed?.moodleModifiedAt).toBe(
      new Date(1_770_000_000_000).toISOString(),
    );
  });

  it('stops the job on a job-wide failure without spending retry budgets', async () => {
    const services = await h.services();
    h.site.downloadErrors.set(
      FakeMoodleSite.pagePath(601),
      new MoodleAuthenticationError('bad token', { code: 'invalidtoken' }),
    );
    const report = await incrementalSync(services, { jobId: 'job-auth' });
    expect(report).toMatchObject({ status: 'failed', failureCategory: 'moodle_authentication' });
    expect(await state(PAGE)).toBeUndefined();
    expect(await h.state.getJob('job-auth')).toMatchObject({
      status: 'failed',
      failureCategory: 'moodle_authentication',
    });
    // The lease was released: the next run can proceed.
    h.site.downloadErrors.clear();
    expect((await incrementalSync(services)).counts.updated).toBe(2);
  });

  it('reports a course Moodle fails to list and carries on', async () => {
    h.site.addCourse(15);
    h.site.setPage(15, 901, { html: pageHtml('Lasers', ['Eye protection is mandatory.']) });
    h.site.contentErrors.set(12, new MoodleTransportError('down', { code: 'timeout' }));
    const report = await incrementalSync(await h.services({ settings: { courseIds: [12, 15] } }));
    expect(report.courses).toEqual([
      { courseId: 12, outcome: 'failed', failureCategory: 'moodle_unavailable' },
      { courseId: 15, outcome: 'synced' },
    ]);
    expect(report.status).toBe('completed_with_failures');
  });
});

describe('concurrency and idempotency', () => {
  it('skips a course another job holds, and runs it once the lease is released or expires', async () => {
    const services = await h.services();
    const lease = await h.state.acquireLease({
      name: courseLeaseName(TENANT_ID, 12),
      owner: 'other-job',
      ttlMs: 600_000,
    });
    const report = await incrementalSync(services);
    expect(report.courses).toEqual([{ courseId: 12, outcome: 'locked' }]);
    expect(report.status).toBe('completed_with_failures');
    expect(h.site.downloads).toHaveLength(0);
    expect((await syncResource(services, 12, PAGE)).courses).toEqual([
      { courseId: 12, outcome: 'locked' },
    ]);

    h.clock.advance(600_001);
    expect((await incrementalSync(services)).counts.updated).toBe(2);
    expect(lease).toBeDefined();
  });

  it('lets only one of two simultaneous jobs process a course', async () => {
    const services = await h.services();
    let open: () => void = () => undefined;
    h.site.downloadGate = new Promise((resolve) => {
      open = resolve;
    });
    const first = incrementalSync(services, { jobId: 'job-a' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await incrementalSync(services, { jobId: 'job-b' });
    open();
    h.site.downloadGate = undefined;
    expect(second.courses).toEqual([{ courseId: 12, outcome: 'locked' }]);
    expect((await first).counts.updated).toBe(2);
  });

  it('serialises jobs across processes with the file state store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ehub-sync-jobs-'));
    try {
      const a = await h.services({
        state: new FileSyncStateRepository({ directory, clock: h.clock }),
      });
      const b = await h.services({
        state: new FileSyncStateRepository({ directory, clock: h.clock }),
      });
      let open: () => void = () => undefined;
      h.site.downloadGate = new Promise((resolve) => {
        open = resolve;
      });
      const first = incrementalSync(a);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await incrementalSync(b);
      open();
      h.site.downloadGate = undefined;
      expect(second.courses[0]?.outcome).toBe('locked');
      expect((await first).counts.updated).toBe(2);
      expect((await incrementalSync(b)).counts.skipped).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('converges: a full sync after an incremental one changes nothing in the index', async () => {
    const services = await h.services();
    await incrementalSync(services);
    const snapshot = JSON.stringify([...h.documents().entries()].sort());
    const full = await fullSync(services);
    expect(full.status).toBe('succeeded');
    expect(entry(full, PAGE)).toMatchObject({ action: 'skipped', reasons: ['content_unchanged'] });
    expect(JSON.stringify([...h.documents().entries()].sort())).toBe(snapshot);
    const again = await fullSync(services);
    expect(again.counts).toMatchObject({ updated: 0, removed: 0, failed: 0 });
  });

  it('reprocesses everything with force', async () => {
    const services = await h.services();
    await incrementalSync(services);
    const forced = await incrementalSync(services, { force: true });
    expect(forced.counts.updated).toBe(2);
    expect(entry(forced, PAGE)?.reasons).toEqual(['forced']);
  });
});

describe('dry runs', () => {
  it('downloads, indexes and stores nothing', async () => {
    const services = await h.services();
    const report = await incrementalSync(services, { dryRun: true, jobId: 'dry' });
    expect(report.dryRun).toBe(true);
    expect(report.counts).toEqual({ processed: 2, skipped: 0, updated: 2, removed: 0, failed: 0 });
    expect(entry(report, PAGE)).toMatchObject({ action: 'would_index', reasons: ['new'] });
    expect(h.site.downloads).toHaveLength(0);
    expect(h.documents().size).toBe(0);
    expect(await h.state.listResources({ tenantId: TENANT_ID })).toEqual([]);
    expect(await h.state.getJob('dry')).toBeUndefined();
    expect(renderSyncReportText(report)).toContain('dry run');
  });

  it('reports what reconciliation would remove', async () => {
    const services = await h.services();
    await incrementalSync(services);
    h.site.removeModule(12, 601);
    const report = await deleteStaleResources(services, { dryRun: true });
    expect(entry(report, PAGE)).toMatchObject({ action: 'would_remove', reasons: ['deleted'] });
    expect(report.counts.removed).toBe(1);
    expect(h.indexedResources()).toEqual([PAGE, PDF]);
  });
});

describe('reconciliation', () => {
  it('removes deleted resources, orphaned chunks and unselected courses, but not missing selected courses', async () => {
    h.site.addCourse(15);
    h.site.setPage(15, 901, { html: pageHtml('Lasers', ['Eye protection is mandatory.']) });
    h.site.addCourse(16);
    h.site.setPage(16, 951, { html: pageHtml('Retail', ['Stock rotation weekly.']) });
    await incrementalSync(await h.services({ settings: { courseIds: [12, 15, 16] } }));
    expect(h.indexedResources()).toHaveLength(4);

    // Chunks the state store does not know about (e.g. the state store was reset).
    const orphan = [...h.documents().values()].find((doc) => doc['resourceId'] === PAGE);
    h.search.seed('ehub-course-content-v1', [
      { ...orphan, id: 'f'.repeat(64), resourceId: '999:page' },
    ]);

    h.site.removeModule(12, 702);
    h.site.removeCourse(16);
    const services = await h.services({ settings: { courseIds: [12, 16] } });
    const downloads = h.site.downloads.length;
    const report = await deleteStaleResources(services);
    expect(entry(report, PDF)).toMatchObject({ action: 'removed', reasons: ['deleted'] });
    expect(entry(report, '999:page')).toMatchObject({
      action: 'removed',
      reasons: ['orphaned_chunks'],
    });
    expect(entry(report, '901:page')).toMatchObject({
      action: 'removed',
      reasons: ['course_not_selected'],
    });
    expect(report.courses).toEqual(
      expect.arrayContaining([
        { courseId: 16, outcome: 'not_found' },
        { courseId: 12, outcome: 'reconciled' },
        { courseId: 15, outcome: 'removed' },
      ]),
    );
    // Course 16 is still selected but Moodle did not return it: kept until deselected.
    expect(h.indexedResources()).toEqual([PAGE, '951:page']);
    // Reconciliation downloads nothing.
    expect(h.site.downloads).toHaveLength(downloads);
  });

  it('refuses to empty a course Moodle suddenly returns empty, unless allowed', async () => {
    for (const id of [801, 802, 803, 804]) {
      h.site.setPage(12, id, { html: pageHtml(`Topic ${String(id)}`, ['Content.']) });
    }
    const services = await h.services();
    await incrementalSync(services);
    expect(h.indexedResources()).toHaveLength(6);
    h.site.clearCourse(12);

    const blocked = await incrementalSync(services);
    expect(blocked.warnings).toContain('deletion_guard');
    expect(blocked.courses).toEqual([{ courseId: 12, outcome: 'synced', deletionGuardBlocked: 6 }]);
    expect(blocked.status).toBe('completed_with_failures');
    expect(h.indexedResources()).toHaveLength(6);
    expect(renderSyncReportText(blocked)).toContain('--allow-mass-delete');

    const allowed = await deleteStaleResources(services, { allowMassDelete: true });
    expect(allowed.counts.removed).toBe(6);
    expect(h.indexedResources()).toEqual([]);
  });

  it('removes a single deleted resource without tripping the guard', async () => {
    const services = await h.services();
    await incrementalSync(services);
    h.site.removeModule(12, 601);
    const report = await incrementalSync(services);
    expect(report.warnings).toEqual([]);
    expect(entry(report, PAGE)).toMatchObject({ action: 'removed' });
  });
});

describe('single course and resource jobs', () => {
  it('syncs one course and one resource, and refuses unselected courses', async () => {
    const services = await h.services();
    const course = await syncCourse(services, 12);
    expect(course.counts.updated).toBe(2);
    await expect(syncCourse(services, 99)).rejects.toBeInstanceOf(SyncSelectionError);
    await expect(syncResource(services, 99, PAGE)).rejects.toBeInstanceOf(SyncSelectionError);
    await expect(
      incrementalSync(await h.services({ settings: { courseIds: [] } })),
    ).rejects.toMatchObject({ code: 'no_course_selection' });

    const resource = await syncResource(services, 12, PAGE, { force: true });
    expect(resource.resources).toHaveLength(1);
    expect(entry(resource, PAGE)).toMatchObject({ action: 'indexed', reasons: ['forced'] });

    const verify = await syncCourse(services, 12, { verify: true });
    expect(entry(verify, PDF)).toMatchObject({ reasons: ['content_unchanged'] });

    h.site.removeModule(12, 601);
    expect(entry(await syncResource(services, 12, PAGE), PAGE)).toMatchObject({
      action: 'removed',
    });
    await expect(syncResource(services, 12, '123:page')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('syncs every course Moodle returns with SYNC_ALL_COURSES', async () => {
    h.site.addCourse(15);
    h.site.setPage(15, 901, { html: pageHtml('Lasers', ['Eye protection is mandatory.']) });
    const report = await incrementalSync(
      await h.services({ settings: { courseIds: undefined, allCourses: true } }),
    );
    expect(report.courses.map((course) => course.courseId)).toEqual([12, 15]);
    expect(report.counts.updated).toBe(3);
  });
});
