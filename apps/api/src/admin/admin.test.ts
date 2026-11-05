import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ADMIN_OID,
  FAILED_RESOURCE,
  INCLUDED_COURSE,
  OTHER_COURSE,
  SECRET_VALUES,
  startAdminHarness,
  type AdminHarness,
} from './__fixtures__/adminHarness.js';
import { failureStage } from './adminData.js';
import { configurationSnapshot } from './configurationSnapshot.js';
import {
  AnswerOutcomeRecorder,
  StoringFeedbackRecorder,
  auditEventSchema,
  usageEventSchema,
} from './events.js';
import { FileEventStore, InMemoryEventStore } from './eventStore.js';
import { AdminJobRunner, JobRunnerBusyError } from './jobRunner.js';

const APP = ['EHub.ApplicationAdministrator'];
const USER_OID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let harness: AdminHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: Parameters<typeof startAdminHarness>[0] = {}): Promise<AdminHarness> {
  harness = await startAdminHarness(options);
  return harness;
}

describe('administration pages', () => {
  it('summarises sync state, answers and feedback on the dashboard', async () => {
    const h = await start();
    await h.usage.append({
      kind: 'answer',
      at: '2026-11-04T12:00:00.000Z',
      status: 'answered',
      correlationId: 'c1',
    });
    await h.usage.append({
      kind: 'answer',
      at: '2026-11-04T12:01:00.000Z',
      status: 'insufficient_evidence',
      correlationId: 'c2',
    });
    await h.usage.append({
      kind: 'answer',
      at: '2026-10-01T12:00:00.000Z',
      status: 'insufficient_evidence',
      correlationId: 'old',
    });
    await h.usage.append({
      kind: 'feedback',
      at: '2026-11-04T12:02:00.000Z',
      answerId: 'a1',
      rating: 'not_useful',
      userKey: '0123456789abcdef',
    });
    const result = await h.request('/admin/api/dashboard');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      lastSuccessfulSync: {
        jobId: 'job-1',
        finishedAt: '2026-11-04T09:05:00.000Z',
        correlationId: 'corr-1',
      },
      activeSyncs: [],
      courses: { selection: 'explicit', included: [INCLUDED_COURSE], withContent: 1 },
      resources: {
        indexed: 1,
        skipped: 1,
        failures: { failed: 1, deadLetter: 0, quarantined: 1 },
        removed: 1,
      },
      answers: { days: 7, answered: 1, insufficientEvidence: 1, failed: 0 },
      feedback: { useful: 0, notUseful: 1 },
    });
  });

  it('lists courses with names only for known courses, and re-index only for included ones', async () => {
    const h = await start();
    const result = await h.request('/admin/api/courses');
    expect(result.body['courses']).toEqual([
      {
        courseId: INCLUDED_COURSE,
        name: 'Consultation Skills',
        inclusion: 'included',
        lastIndexedAt: '2026-11-04T10:00:00.000Z',
        resourceCount: 1,
        failureCount: 2,
        canReindex: true,
      },
      expect.objectContaining({
        courseId: OTHER_COURSE,
        inclusion: 'not_selected',
        canReindex: false,
        name: null,
      }),
    ]);
  });

  it('lists failures by stage with sanitised categories, and sync jobs with summaries', async () => {
    const h = await start();
    const failures = await h.request('/admin/api/failures');
    expect(failures.body['failures']).toEqual([
      expect.objectContaining({
        resourceId: FAILED_RESOURCE,
        stage: 'download',
        category: 'moodle_unavailable',
        retryCount: 2,
        canRetry: true,
      }),
      expect.objectContaining({
        resourceId: '703:page',
        stage: 'extraction',
        category: 'encrypted',
        status: 'quarantined',
      }),
    ]);
    const jobs = await h.request('/admin/api/jobs');
    expect(jobs.body['jobs']).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        jobType: 'incremental',
        status: 'succeeded',
        correlationId: 'corr-1',
        summary: {
          courses: 1,
          processed: 4,
          skipped: 1,
          updated: 2,
          removed: 0,
          failed: 1,
          failureCategory: null,
        },
      }),
    ]);
  });

  it('shows configuration without any secret', async () => {
    const h = await start();
    const result = await h.request('/admin/api/configuration');
    expect(result.status).toBe(200);
    for (const secret of Object.values(SECRET_VALUES)) {
      expect(result.text).not.toContain(secret);
    }
    for (const name of Object.keys(SECRET_VALUES)) {
      expect(result.text).not.toContain(`"${name}"`);
    }
    expect(result.text).toContain('RETRIEVAL_TOP_K');
    expect(result.text).toContain('"MOODLE_COURSE_AUTHORIZATION","value":true');
  });

  it('flags a running job as possibly stale after its lease time', async () => {
    const h = await start();
    await h.state.saveJob({
      jobId: 'job-crashed',
      jobType: 'full',
      tenantId: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      dryRun: false,
      startedAt: '2026-11-04T01:00:00.000Z',
      courseIds: [],
      counts: { processed: 0, skipped: 0, updated: 0, removed: 0, failed: 0 },
    });
    const result = await h.request('/admin/api/dashboard');
    expect(result.body['activeSyncs']).toEqual([
      expect.objectContaining({ jobId: 'job-crashed', possiblyStale: true }),
    ]);
  });
});

describe('administration actions', () => {
  it('starts manual jobs and audits them with the actor and correlation ID', async () => {
    const h = await start();
    const sync = await h.request('/admin/api/actions/incremental-sync', {
      body: {},
      headers: { 'x-correlation-id': 'admin-req-1' },
    });
    expect(sync.status).toBe(202);
    await h.runner.idle();
    const retry = await h.request('/admin/api/actions/retry', {
      body: { courseId: INCLUDED_COURSE, resourceId: FAILED_RESOURCE },
    });
    expect(retry.status).toBe(202);
    await h.runner.idle();
    expect(h.jobs).toEqual([
      { kind: 'incremental' },
      { kind: 'retry', courseId: INCLUDED_COURSE, resourceId: FAILED_RESOURCE },
    ]);
    expect(h.audit.events[0]).toMatchObject({
      action: 'sync.incremental',
      outcome: 'accepted',
      actor: { objectId: ADMIN_OID, roles: APP, method: 'entra-access-token' },
      target: { jobId: sync.body['jobId'] },
      correlationId: 'admin-req-1',
    });
    expect((await h.request('/admin/api/jobs')).body['runner']).toMatchObject({
      busy: false,
      last: { kind: 'retry', status: 'succeeded' },
    });
  });

  it('requires confirmation for destructive actions', async () => {
    const h = await start();
    for (const [path, body] of [
      ['/admin/api/actions/reindex', { courseId: INCLUDED_COURSE }],
      ['/admin/api/actions/enrolment-refresh', { scope: 'all' }],
      ['/admin/api/identity/mappings', { entraObjectId: USER_OID, moodleUserId: 501 }],
      ['/admin/api/identity/mappings/remove', { entraObjectId: USER_OID }],
    ] as const) {
      const result = await h.request(path, { body });
      expect(result.status, path).toBe(400);
      expect(result.body).toMatchObject({ error: { code: 'confirmation_required' } });
    }
    expect(h.jobs).toEqual([]);
    expect(h.invalidated).toEqual([]);
    expect(h.audit.events.map((event) => event.outcome)).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
    ]);
    expect(h.audit.events.every((event) => event.reason === 'confirmation_required')).toBe(true);
  });

  it('never acts on courses outside the selection or resources that are not failing', async () => {
    const h = await start();
    const reindex = await h.request('/admin/api/actions/reindex', {
      body: { courseId: OTHER_COURSE, confirm: true },
    });
    expect(reindex).toMatchObject({
      status: 403,
      body: { error: { code: 'course_not_included' } },
    });
    const arbitrary = await h.request('/admin/api/actions/reindex', {
      body: { courseId: 424242, confirm: true },
    });
    expect(arbitrary.status).toBe(403);
    const notFailing = await h.request('/admin/api/actions/retry', {
      body: { courseId: INCLUDED_COURSE, resourceId: '701:chapter:11' },
    });
    expect(notFailing).toMatchObject({
      status: 409,
      body: { error: { code: 'resource_not_failing' } },
    });
    const otherCourse = await h.request('/admin/api/actions/retry', {
      body: { courseId: OTHER_COURSE, resourceId: '901:page' },
    });
    expect(otherCourse.body).toMatchObject({ error: { code: 'course_not_included' } });
    expect(h.jobs).toEqual([]);
    expect(h.audit.events.map((event) => event.reason)).toEqual([
      'course_not_included',
      'course_not_included',
      'resource_not_failing',
      'course_not_included',
    ]);
  });

  it('runs one manual job at a time', async () => {
    const h = await start({ holdJobs: true });
    expect((await h.request('/admin/api/actions/incremental-sync', { body: {} })).status).toBe(202);
    const second = await h.request('/admin/api/actions/reindex', {
      body: { courseId: INCLUDED_COURSE, confirm: true },
    });
    expect(second).toMatchObject({ status: 409, body: { error: { code: 'job_running' } } });
    expect((await h.request('/admin/api/dashboard')).body['runner']).toMatchObject({
      busy: true,
      current: { kind: 'incremental' },
    });
    h.release();
    await h.runner.idle();
    expect(
      (
        await h.request('/admin/api/actions/reindex', {
          body: { courseId: INCLUDED_COURSE, confirm: true },
        })
      ).status,
    ).toBe(202);
  });

  it('validates every body strictly', async () => {
    const h = await start();
    for (const body of [
      { courseId: '12', confirm: true },
      { courseId: 12, confirm: 'yes' },
      { courseId: -1, confirm: true },
      { courseId: 12, confirm: true, force: true },
      [],
      null,
    ]) {
      const result = await h.request('/admin/api/actions/reindex', { body });
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body).toMatchObject({ error: { code: 'invalid_request' } });
    }
    const map = await h.request('/admin/api/identity/mappings', {
      body: { entraObjectId: 'not-a-guid', moodleUserId: 501, confirm: true },
    });
    expect(map.status).toBe(400);
    const tooBig = await h.request('/admin/api/actions/retry', {
      body: { courseId: 12, resourceId: 'x'.repeat(20_000) },
    });
    expect(tooBig.status).toBe(413);
    const form = await fetch(`${h.url}/admin/api/actions/incremental-sync`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await h.tokenFor(APP)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'a=b',
    });
    expect(form.status).toBe(415);
  });

  it('refuses mutations from another origin or a cross-site request', async () => {
    const h = await start({ publicOrigin: 'https://ehub-api.example.com' });
    const forged = await h.request('/admin/api/actions/incremental-sync', {
      body: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(forged).toMatchObject({ status: 403, body: { error: { code: 'origin_rejected' } } });
    const crossSite = await h.request('/admin/api/actions/incremental-sync', {
      body: {},
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const own = await h.request('/admin/api/actions/incremental-sync', {
      body: {},
      headers: { origin: 'https://ehub-api.example.com', 'sec-fetch-site': 'same-origin' },
    });
    expect(own.status).toBe(202);
    expect(h.audit.events.map((event) => event.reason ?? event.outcome)).toEqual([
      'origin_rejected',
      'origin_rejected',
      'accepted',
    ]);
  });

  it('approves an identity override only for an active Moodle account, and invalidates access', async () => {
    const h = await start();
    const suspended = await h.request('/admin/api/identity/mappings', {
      body: { entraObjectId: USER_OID, moodleUserId: 502, confirm: true },
    });
    expect(suspended).toMatchObject({
      status: 422,
      body: { error: { code: 'moodle_account_not_active', reason: 'moodle_user_suspended' } },
    });
    const ok = await h.request('/admin/api/identity/mappings', {
      body: {
        entraObjectId: USER_OID.toUpperCase(),
        moodleUserId: 501,
        reference: 'IT-77',
        confirm: true,
      },
    });
    expect(ok.status).toBe(200);
    const key = { tenantId: '11111111-1111-4111-8111-111111111111', objectId: USER_OID };
    expect(await h.identity.getMapping(key)).toMatchObject({
      moodleUserId: 501,
      approvedBy: ADMIN_OID,
      reference: 'IT-77',
    });
    expect(h.invalidated).toEqual([key]);
    expect(await h.identity.listInvalidations()).toEqual([
      expect.objectContaining({ scope: key, reason: 'mapping_changed' }),
    ]);
    const listed = await h.request('/admin/api/identity');
    expect(listed.body['mappings']).toEqual([
      expect.objectContaining({
        entraObjectId: USER_OID,
        moodleUserId: 501,
        method: 'explicit',
        status: 'approved',
      }),
    ]);
    const removed = await h.request('/admin/api/identity/mappings/remove', {
      body: { entraObjectId: USER_OID, confirm: true },
    });
    expect(removed.status).toBe(200);
    expect(
      (
        await h.request('/admin/api/identity/mappings/remove', {
          body: { entraObjectId: USER_OID, confirm: true },
        })
      ).status,
    ).toBe(404);
    h.moodle.failLookups = true;
    expect(
      (
        await h.request('/admin/api/identity/mappings', {
          body: { entraObjectId: USER_OID, moodleUserId: 501, confirm: true },
        })
      ).body,
    ).toMatchObject({ error: { code: 'moodle_unavailable' } });
    expect(h.audit.events.map((event) => `${event.action}:${event.outcome}`)).toEqual([
      'identity.map:refused',
      'identity.map:accepted',
      'identity.unmap:accepted',
      'identity.unmap:refused',
      'identity.map:failed',
    ]);
  });

  it('refreshes cached course access for one user or everyone', async () => {
    const h = await start();
    expect(
      (
        await h.request('/admin/api/actions/enrolment-refresh', {
          body: { scope: 'user', entraObjectId: USER_OID },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request('/admin/api/actions/enrolment-refresh', {
          body: { scope: 'all', confirm: true },
        })
      ).status,
    ).toBe(200);
    expect(h.invalidated).toEqual([
      { tenantId: '11111111-1111-4111-8111-111111111111', objectId: USER_OID },
      'all',
    ]);
    expect((await h.identity.listInvalidations()).map((entry) => entry.scope)).toEqual([
      { tenantId: '11111111-1111-4111-8111-111111111111', objectId: USER_OID },
      'all',
    ]);
  });

  it('reports identity actions as unavailable without Moodle authorisation', async () => {
    const h = await start({ withIdentity: false });
    const result = await h.request('/admin/api/actions/enrolment-refresh', {
      body: { scope: 'all', confirm: true },
    });
    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'identity_not_configured' } },
    });
  });

  it('logs no tokens and no request bodies', async () => {
    const h = await start();
    const token = await h.tokenFor(APP);
    await h.request('/admin/api/identity/mappings', {
      token,
      body: {
        entraObjectId: USER_OID,
        moodleUserId: 501,
        reference: 'Zebra-ticket-99',
        confirm: true,
      },
    });
    const logs = h.logs.join('\n');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('Zebra-ticket-99');
  });
});

describe('administration page delivery', () => {
  it('serves the page with a strict content security policy and no inline script', async () => {
    const h = await start();
    const page = await fetch(`${h.url}/admin`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const html = await page.text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain('style=');
    for (const asset of ['/admin/app.js', '/admin/app.css', '/admin/vendor/msal-browser.min.js']) {
      const response = await fetch(`${h.url}${asset}`);
      expect(response.status, asset).toBe(200);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect((await fetch(`${h.url}/admin/../package.json`)).status).toBe(404);
    expect((await fetch(`${h.url}/admin/app.js`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${h.url}/admin/nothing`)).status).toBe(404);
  });

  it('uses no HTML parsing for server data in the page script', () => {
    const script = readFileSync(new URL('../../admin-ui/app.js', import.meta.url), 'utf8');
    for (const sink of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
    ]) {
      expect(script, sink).not.toContain(sink);
    }
  });

  it('publishes the sign-in configuration without credentials', async () => {
    const h = await start();
    const result = await h.request('/admin/api/client-config', { token: null });
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['authority', 'clientId', 'mode', 'scopes']);
    expect(result.text).not.toMatch(/secret/i);
  });
});

describe('administration records', () => {
  it('stores events in daily files, skips damaged lines and prunes by retention', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ehub-events-'));
    try {
      let now = new Date('2026-11-05T08:00:00.000Z');
      const store = new FileEventStore({
        directory,
        schema: usageEventSchema,
        timeOf: (e) => e.at,
        now: () => now,
      });
      await store.append({
        kind: 'answer',
        at: '2026-08-01T10:00:00.000Z',
        status: 'answered',
        correlationId: 'old',
      });
      await store.append({
        kind: 'answer',
        at: '2026-11-05T07:00:00.000Z',
        status: 'failed',
        correlationId: 'new',
      });
      writeFileSync(join(directory, '2026-11-05.jsonl'), 'not json\n{"kind":"answer"}\n', {
        flag: 'a',
      });
      const read = await store.read(new Date('2026-01-01T00:00:00.000Z'));
      expect(read.events.map((event) => event.kind === 'answer' && event.correlationId)).toEqual([
        'old',
        'new',
      ]);
      expect(read.invalid).toBe(2);
      await expect(
        store.append({
          kind: 'answer',
          at: 'yesterday',
          status: 'answered',
          correlationId: 'x',
        } as never),
      ).rejects.toThrow();
      expect(await store.prune(90)).toBe(1);
      now = new Date('2026-11-05T09:00:00.000Z');
      expect((await store.read(new Date(0))).events).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps feedback pseudonymous and never fails an answer on a storage error', async () => {
    const usage = new InMemoryEventStore({ schema: usageEventSchema, timeOf: (e) => e.at });
    const logged: unknown[] = [];
    const recorder = new StoringFeedbackRecorder(usage, {
      record: (event) => {
        logged.push(event);
        return Promise.resolve();
      },
    });
    await recorder.record({
      answerId: 'a1',
      rating: 'useful',
      userId: USER_OID,
      receivedAt: '2026-11-05T08:00:00.000Z',
    });
    expect(JSON.stringify(usage.events)).not.toContain(USER_OID);
    expect(usage.events[0]).toMatchObject({ kind: 'feedback', rating: 'useful' });
    const failing = new AnswerOutcomeRecorder(
      {
        append: () => Promise.reject(new Error('disk full')),
        read: () => Promise.reject(new Error('x')),
        prune: () => Promise.resolve(0),
      },
      createLogger({ service: 'test', level: 'silent' }),
    );
    await expect(
      failing.record({ at: '2026-11-05T08:00:00.000Z', status: 'answered', correlationId: 'c' }),
    ).resolves.toBeUndefined();
  });

  it('accepts only well-formed audit records', () => {
    expect(
      auditEventSchema.safeParse({
        at: '2026-11-05T08:00:00.000Z',
        action: 'course.reindex',
        outcome: 'accepted',
        actor: { objectId: ADMIN_OID, roles: APP, method: 'entra-access-token' },
        correlationId: 'c',
        target: { courseId: 12, note: 'free text' },
      }).success,
    ).toBe(false);
  });

  it('maps failure categories to pipeline stages', () => {
    expect(failureStage('moodle_file_forbidden')).toBe('download');
    expect(failureStage('file_too_large')).toBe('download');
    expect(failureStage('embedding_unavailable')).toBe('embedding');
    expect(failureStage('index_partial_failure')).toBe('indexing');
    expect(failureStage('no_indexable_text')).toBe('chunking');
    expect(failureStage('corrupt')).toBe('extraction');
    expect(failureStage('state_conflict')).toBe('state');
    expect(failureStage(undefined)).toBe('unknown');
  });

  it('runs jobs in the background and reports setup failures', async () => {
    const runner = new AdminJobRunner({
      openServices: () =>
        Promise.reject(Object.assign(new Error('no index'), { code: 'index_missing' })),
      logger: createLogger({ service: 'test', level: 'silent' }),
    });
    runner.start({ kind: 'incremental' }, 'c1');
    expect(() => runner.start({ kind: 'incremental' }, 'c2')).toThrow(JobRunnerBusyError);
    await runner.idle();
    expect(runner.status()).toMatchObject({
      busy: false,
      last: { status: 'setup_failed', failureCategory: 'index_missing' },
    });
  });

  it('builds the configuration page from an allow-list', () => {
    const sections = configurationSnapshot({
      NODE_ENV: 'test',
      ...SECRET_VALUES,
      AZURE_CLIENT_SECRET: 'client-secret-value-0123456789',
    });
    const text = JSON.stringify(sections);
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('do-not-show');
    expect(sections.map((section) => section.title)).toEqual([
      'Included courses',
      'Retrieval',
      'Synchronisation',
      'Features',
      'Logging',
      'Retention and caching',
    ]);
  });
});
