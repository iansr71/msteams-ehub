import { afterEach, describe, expect, it } from 'vitest';

import {
  FAILED_RESOURCE,
  INCLUDED_COURSE,
  startAdminHarness,
  type AdminHarness,
} from './__fixtures__/adminHarness.js';
import { PERMISSIONS, ROLE_PERMISSIONS, canAdminister, permissionsOf } from './roles.js';

/*
 * Requirement 10: every endpoint against every role, enforced by the server whatever the page
 * shows. "Allowed" means the request got past authorisation (2xx); "denied" means 403
 * forbidden, with an audit record for mutations.
 */

const ROLES = {
  none: [],
  user: ['EHub.User'],
  auditor: ['EHub.Auditor'],
  content: ['EHub.ContentAdministrator'],
  application: ['EHub.ApplicationAdministrator'],
  foreign: ['Other.Admin', 'ehub.applicationadministrator'],
  userAndAuditor: ['EHub.User', 'EHub.Auditor'],
} as const;
type RoleName = keyof typeof ROLES;

interface Endpoint {
  readonly name: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly allowed: readonly RoleName[];
}

const VIEWERS: readonly RoleName[] = ['auditor', 'content', 'application', 'userAndAuditor'];

const ENDPOINTS: readonly Endpoint[] = [
  { name: 'dashboard', path: '/admin/api/dashboard', allowed: VIEWERS },
  { name: 'courses', path: '/admin/api/courses', allowed: VIEWERS },
  { name: 'jobs', path: '/admin/api/jobs', allowed: VIEWERS },
  { name: 'failures', path: '/admin/api/failures', allowed: VIEWERS },
  { name: 'configuration', path: '/admin/api/configuration', allowed: VIEWERS },
  {
    name: 'identity',
    path: '/admin/api/identity',
    allowed: ['auditor', 'application', 'userAndAuditor'],
  },
  {
    name: 'audit',
    path: '/admin/api/audit',
    allowed: ['auditor', 'application', 'userAndAuditor'],
  },
  {
    name: 'incremental sync',
    path: '/admin/api/actions/incremental-sync',
    body: {},
    allowed: ['content', 'application'],
  },
  {
    name: 'course re-index',
    path: '/admin/api/actions/reindex',
    body: { courseId: INCLUDED_COURSE, confirm: true },
    allowed: ['content', 'application'],
  },
  {
    name: 'resource retry',
    path: '/admin/api/actions/retry',
    body: { courseId: INCLUDED_COURSE, resourceId: FAILED_RESOURCE },
    allowed: ['content', 'application'],
  },
  {
    name: 'enrolment cache refresh',
    path: '/admin/api/actions/enrolment-refresh',
    body: { scope: 'all', confirm: true },
    allowed: ['application'],
  },
  {
    name: 'identity mapping',
    path: '/admin/api/identity/mappings',
    body: {
      entraObjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      moodleUserId: 501,
      confirm: true,
    },
    allowed: ['application'],
  },
  {
    name: 'identity unmapping',
    path: '/admin/api/identity/mappings/remove',
    body: { entraObjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', confirm: true },
    allowed: ['application'],
  },
];

let harness: AdminHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('administration role boundaries', () => {
  const cases = ENDPOINTS.flatMap((endpoint) =>
    (Object.keys(ROLES) as RoleName[]).map((role) => [endpoint.name, role, endpoint] as const),
  );

  it.each(cases)('%s as %s', async (_name, role, endpoint) => {
    harness = await startAdminHarness();
    if (endpoint.name === 'identity unmapping') {
      await harness.identity.saveMapping({
        tenantId: '11111111-1111-4111-8111-111111111111',
        objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        moodleUserId: 501,
        approvedBy: 'Dep',
        approvedAt: new Date().toISOString(),
      });
    }
    const result = await harness.request(endpoint.path, {
      token: await harness.tokenFor(ROLES[role]),
      ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
    });
    await harness.runner.idle();
    if (endpoint.allowed.includes(role)) {
      expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(200);
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
    } else {
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: 'forbidden' } });
    }
    if (endpoint.body !== undefined) {
      // Every mutation attempt by a signed-in user is audited, allowed or not.
      expect(harness.audit.events).toHaveLength(1);
      expect(harness.audit.events[0]).toMatchObject({
        outcome: endpoint.allowed.includes(role) ? 'accepted' : 'refused',
        ...(endpoint.allowed.includes(role) ? {} : { reason: 'forbidden' }),
      });
      if (!endpoint.allowed.includes(role)) {
        expect(harness.jobs).toEqual([]);
        expect(harness.invalidated).toEqual([]);
      }
    } else {
      expect(harness.audit.events).toEqual([]);
    }
  });

  it('refuses every endpoint without a valid token (401), and audits nothing', async () => {
    harness = await startAdminHarness();
    for (const endpoint of ENDPOINTS) {
      for (const token of [
        null,
        'not-a-token',
        await harness.kit.signWithUnknownKey({ roles: ['EHub.ApplicationAdministrator'] }),
      ]) {
        const result = await harness.request(endpoint.path, {
          token,
          ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
        });
        expect(result.status, endpoint.name).toBe(401);
        expect(result.headers.get('www-authenticate')).toBe('Bearer');
      }
    }
    expect((await harness.request('/admin/api/me', { token: null })).status).toBe(401);
    expect(harness.audit.events).toEqual([]);
    expect(harness.jobs).toEqual([]);
  });

  it('answers "me" for any signed-in user, with only the permissions their roles give', async () => {
    harness = await startAdminHarness();
    const user = await harness.request('/admin/api/me', {
      token: await harness.tokenFor(['EHub.User']),
    });
    expect(user.body).toMatchObject({ roles: ['EHub.User'], permissions: [] });
    const content = await harness.request('/admin/api/me', {
      token: await harness.tokenFor(['EHub.ContentAdministrator', 'Other.Admin']),
    });
    expect(content.body['roles']).toEqual(['EHub.ContentAdministrator']);
    expect(content.body['permissions']).toEqual(ROLE_PERMISSIONS['EHub.ContentAdministrator']);
  });
});

describe('role permissions', () => {
  it('gives the application administrator everything and EHub.User nothing', () => {
    expect([...permissionsOf(['EHub.ApplicationAdministrator'])].sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
    expect(permissionsOf(['EHub.User']).size).toBe(0);
    expect(canAdminister(['EHub.User'])).toBe(false);
    expect(canAdminister(['EHub.Auditor'])).toBe(true);
  });

  it('keeps the auditor read-only and content administrators away from identity', () => {
    expect([...permissionsOf(['EHub.Auditor'])].some((p) => p.startsWith('action:'))).toBe(false);
    const content = permissionsOf(['EHub.ContentAdministrator']);
    expect(content.has('view:identity')).toBe(false);
    expect(content.has('action:identity')).toBe(false);
    expect(content.has('action:enrolment-refresh')).toBe(false);
    expect(content.has('view:audit')).toBe(false);
  });

  it('matches role names exactly (case and spelling)', () => {
    expect(
      permissionsOf(['ehub.applicationadministrator', 'EHub.Admin', ' EHub.Auditor']).size,
    ).toBe(0);
  });
});
