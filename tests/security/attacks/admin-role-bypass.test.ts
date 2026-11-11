import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startAdminHarness,
  type AdminHarness,
} from '../../../apps/api/src/admin/__fixtures__/adminHarness.js';
import { withForgedPayload } from '../../../apps/api/src/auth/__fixtures__/tokens.js';

/*
 * Attack tests: reaching administration actions without the role. The exhaustive
 * endpoint-by-role matrix is apps/api/src/admin/adminRoles.test.ts; these are the bypass
 * attempts around it. Every case must leave no job started and no cache invalidated.
 */

const SYNC = '/admin/api/actions/incremental-sync';

let harness: AdminHarness | undefined;
afterEach(async () => {
  await harness?.runner.idle();
  await harness?.server.close();
  harness = undefined;
});

/** POSTs `{}` to the exact path given, without client-side URL normalisation. */
function rawPost(baseUrl: string, path: string, token: string): Promise<number> {
  const target = new URL(baseUrl);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          origin: baseUrl,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

function expectNothingHappened(target: AdminHarness): void {
  expect(target.jobs).toEqual([]);
  expect(target.invalidated).toEqual([]);
}

describe('attack: admin-role bypass', () => {
  it.each([
    ['no roles', []],
    ['the ordinary user role', ['EHub.User']],
    ['the read-only auditor role', ['EHub.Auditor']],
    ['a lower-case role name', ['ehub.applicationadministrator']],
    ['a role name with a trailing space', ['EHub.ApplicationAdministrator ']],
    ['a prefix of a role', ['EHub.Application']],
    ['a role with a suffix', ['EHub.ApplicationAdministrator.Extra']],
    ['a wildcard', ['*']],
    ['another app’s admin role', ['Admin', 'Global Administrator', 'Application.ReadWrite.All']],
    ['a comma-joined string', ['EHub.User,EHub.ApplicationAdministrator']],
  ])('refuses a mutation with %s', async (_label, roles) => {
    harness = await startAdminHarness();
    const result = await harness.request(SYNC, {
      body: {},
      token: await harness.tokenFor(roles),
    });
    expect(result.status).toBe(403);
    expectNothingHappened(harness);
  });

  it('ignores roles stated anywhere except the validated token', async () => {
    harness = await startAdminHarness();
    const token = await harness.tokenFor(['EHub.User']);
    const result = await harness.request(`${SYNC}?roles=EHub.ApplicationAdministrator`, {
      body: { roles: ['EHub.ApplicationAdministrator'], role: 'EHub.ApplicationAdministrator' },
      token,
      headers: {
        'x-roles': 'EHub.ApplicationAdministrator',
        'x-ms-client-principal': Buffer.from(
          JSON.stringify({ userRoles: ['EHub.ApplicationAdministrator'] }),
        ).toString('base64'),
        'x-ehub-mock-roles': 'EHub.ApplicationAdministrator',
      },
    });
    expect([400, 403]).toContain(result.status);
    expectNothingHappened(harness);
  });

  it('rejects a token edited to add the administrator role', async () => {
    harness = await startAdminHarness();
    const forged = withForgedPayload(await harness.tokenFor(['EHub.User']), {
      roles: ['EHub.ApplicationAdministrator'],
    });
    const result = await harness.request(SYNC, { body: {}, token: forged });
    expect(result.status).toBe(401);
    expectNothingHappened(harness);
  });

  it('does not treat Entra directory roles or groups as application roles', async () => {
    harness = await startAdminHarness();
    const token = await harness.kit.sign({
      oid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      // Global Administrator's well-known directory role template ID, and a group.
      wids: ['62e90394-69f5-4237-9190-012177145e10'],
      groups: ['EHub.ApplicationAdministrator'],
      scp: 'access_as_user',
    });
    const result = await harness.request(SYNC, { body: {}, token });
    expect(result.status).toBe(403);
    expectNothingHappened(harness);
  });

  it.each([
    ['an upper-case path', '/ADMIN/api/actions/incremental-sync'],
    ['a doubled slash', '/admin//api/actions/incremental-sync'],
    ['a dot segment', '/admin/api/./actions/incremental-sync'],
    ['a traversal through a public path', '/health/../admin/api/actions/incremental-sync'],
    ['an encoded slash', '/admin/api/actions%2fincremental-sync'],
    ['a trailing path', '/admin/api/actions/incremental-sync/extra'],
  ])('does not expose the action through %s to a non-admin', async (_label, path) => {
    harness = await startAdminHarness();
    const token = await harness.tokenFor(['EHub.User']);
    // Sent raw: fetch would normalise dot segments before the server saw them.
    const status = await rawPost(harness.url, path, token);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expectNothingHappened(harness);
  });

  it('applies the same role check to an administrator-only path however it is spelled', async () => {
    harness = await startAdminHarness();
    const auditor = await harness.tokenFor(['EHub.Auditor']);
    for (const path of [
      '/admin/api/./actions/incremental-sync',
      '/health/../admin/api/actions/incremental-sync',
      '/admin/api/actions/../actions/incremental-sync',
    ]) {
      expect(await rawPost(harness.url, path, auditor), path).not.toBe(202);
    }
    await harness.runner.idle();
    expectNothingHappened(harness);
  });

  it('does not let a read (GET) or a method-override header perform a mutation', async () => {
    harness = await startAdminHarness();
    const token = await harness.tokenFor(['EHub.Auditor']);
    const get = await harness.request(SYNC, { method: 'GET', token });
    expect(get.status).toBeGreaterThanOrEqual(400);
    const overridden = await harness.request('/admin/api/me', {
      method: 'GET',
      token,
      headers: { 'x-http-method-override': 'POST', 'x-original-url': SYNC, 'x-rewrite-url': SYNC },
    });
    expect(overridden.status).toBe(200);
    expectNothingHappened(harness);
  });

  it('refuses an administrator’s mutation sent from another origin', async () => {
    harness = await startAdminHarness();
    const result = await harness.request(SYNC, {
      body: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(result.status).toBe(403);
    expectNothingHappened(harness);
  });

  it('refuses a destructive action without explicit confirmation, even for an administrator', async () => {
    harness = await startAdminHarness();
    const result = await harness.request('/admin/api/actions/reindex', { body: { courseId: 12 } });
    expect(result.status).toBe(400);
    expectNothingHappened(harness);
  });

  it('records every refused attempt in the audit trail without the token', async () => {
    harness = await startAdminHarness();
    const token = await harness.tokenFor(['EHub.User']);
    await harness.request(SYNC, { body: {}, token });
    expect(harness.audit.events).toHaveLength(1);
    expect(harness.audit.events[0]).toMatchObject({ outcome: 'refused', reason: 'forbidden' });
    const recorded = JSON.stringify(harness.audit.events) + harness.logs.join('\n');
    expect(recorded).not.toContain(token);
    expect(recorded).not.toContain(token.split('.')[2] ?? token);
  });
});
