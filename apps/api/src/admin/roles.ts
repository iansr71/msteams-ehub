import { ADMIN_ROLES, type AdminRole } from '@ehub/shared';

/*
 * Who may do what in the administration area. Permissions come only from the `roles` claim of
 * a validated Entra token; the server checks them on every request, whatever the page shows.
 *
 * - EHub.User: uses the assistant; no administration access.
 * - EHub.Auditor: reads everything, including the audit trail; changes nothing.
 * - EHub.ContentAdministrator: reads content state; runs syncs, re-indexes, retries.
 * - EHub.ApplicationAdministrator: everything, including identity mappings and the enrolment
 *   cache.
 */

export const PERMISSIONS = [
  'view:content',
  'view:configuration',
  'view:identity',
  'view:audit',
  'action:sync',
  'action:reindex',
  'action:retry',
  'action:identity',
  'action:enrolment-refresh',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly Permission[]>> = {
  'EHub.User': [],
  'EHub.Auditor': ['view:content', 'view:configuration', 'view:identity', 'view:audit'],
  'EHub.ContentAdministrator': [
    'view:content',
    'view:configuration',
    'action:sync',
    'action:reindex',
    'action:retry',
  ],
  'EHub.ApplicationAdministrator': [...PERMISSIONS],
};

const ROLE_SET: ReadonlySet<string> = new Set(ADMIN_ROLES);

/** The known roles in a token; anything else (e.g. other apps' roles) is ignored. */
export function adminRolesOf(roles: readonly string[]): AdminRole[] {
  return ADMIN_ROLES.filter((role) => roles.includes(role) && ROLE_SET.has(role));
}

export function permissionsOf(roles: readonly string[]): ReadonlySet<Permission> {
  return new Set(adminRolesOf(roles).flatMap((role) => ROLE_PERMISSIONS[role]));
}

/** Any permission at all: the condition for seeing the administration area. */
export function canAdminister(roles: readonly string[]): boolean {
  return permissionsOf(roles).size > 0;
}
