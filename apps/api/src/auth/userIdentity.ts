import { z } from 'zod';

/*
 * The caller, built only from validated token claims (or, in development, the explicit mock
 * identity). Nothing in a request body or a Teams message contributes to it.
 */

const lowerGuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  .transform((value) => value.toLowerCase());
const boundedText = z.string().trim().min(1).max(256);

export const userIdentitySchema = z.strictObject({
  tenantId: lowerGuid,
  objectId: lowerGuid,
  userPrincipalName: boundedText.optional(),
  /** Which claim userPrincipalName came from; only `upn` is used for Moodle username rules. */
  userPrincipalNameSource: z.enum(['upn', 'preferred_username']).optional(),
  /** Lower-cased; only from the `email` claim (an optional claim in the API registration). */
  email: z.email().max(256).optional(),
  /** The email claim exactly as issued, for exact matching in case-sensitive Moodle databases. */
  emailAsIssued: boundedText.optional(),
  displayName: boundedText.optional(),
  /** App roles assigned to the user for the API (`roles` claim), if any. */
  roles: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,120}$/)).max(50),
  authentication: z.strictObject({
    method: z.enum(['entra-access-token', 'dev-mock']),
    /** The application that requested the token (`azp`). */
    clientAppId: lowerGuid.optional(),
    /** Delegated scopes granted (`scp`). */
    scopes: z.array(z.string().max(120)).max(50),
    /** `acct` optional claim: 0 member, 1 guest. */
    accountType: z.enum(['member', 'guest']).optional(),
    /** Guest's home identity provider (`idp`), when Entra ID reports one. */
    identityProvider: z.string().max(256).optional(),
    /** Authentication methods (`amr`), when present. */
    methods: z.array(z.string().max(40)).max(10).optional(),
  }),
});
export type UserIdentity = z.output<typeof userIdentitySchema>;

/** The development mock user's fixed object ID (not a real directory object). */
export const MOCK_OBJECT_ID = '00000000-0000-4000-8000-00000000d0d0';

export function mockIdentity(tenantId: string, label: string): UserIdentity {
  return userIdentitySchema.parse({
    tenantId,
    objectId: MOCK_OBJECT_ID,
    displayName: `Development mock user (${label})`,
    roles: [],
    authentication: { method: 'dev-mock', scopes: [] },
  });
}
