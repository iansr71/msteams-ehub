import { z } from 'zod';

/*
 * What the identity store keeps. Records hold IDs, reason codes and timestamps. Email and UPN
 * appear only in identity observations, which the admin commands need to re-run a mapping for a
 * user who is not signing in at that moment.
 */

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const moodleUserId = z.number().int().positive().max(2_147_483_647);
const courseId = z.number().int().positive().max(2_147_483_647);
const isoTime = z.iso.datetime();
const actor = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._@'-]{0,99}$/, { message: 'Must be a short name or ID.' });

/** Users are keyed by tenant and Entra object ID, both lower-case GUIDs. */
export const entraUserKeySchema = z.strictObject({ tenantId: guid, objectId: guid });
export type EntraUserKey = z.output<typeof entraUserKeySchema>;

export function userKeyString(key: EntraUserKey): string {
  return `${key.tenantId}:${key.objectId}`;
}

/** An administrator-approved link between an Entra user and a Moodle account. */
export const explicitMappingSchema = z.strictObject({
  ...entraUserKeySchema.shape,
  moodleUserId,
  approvedBy: actor,
  approvedAt: isoTime,
  /** Why the mapping exists, e.g. a ticket number. No personal data. */
  reference: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._#:/-]{0,99}$/)
    .optional(),
});
export type ExplicitMapping = z.output<typeof explicitMappingSchema>;

export const MAPPING_METHODS = ['explicit', 'email', 'upn_username'] as const;
export type MappingMethod = (typeof MAPPING_METHODS)[number];

export const MAPPING_FAILURE_REASONS = [
  /** No rule produced a candidate. */
  'no_match',
  /** The token carried neither an email nor a usable UPN. */
  'no_usable_claims',
  /** More than one Moodle account matched; never resolved automatically. */
  'ambiguous_email',
  'ambiguous_username',
  /** The explicitly mapped Moodle account no longer exists or cannot be seen. */
  'mapped_user_not_found',
  'moodle_user_suspended',
  /** Moodle did not say whether the account is suspended (hidden user fields). */
  'moodle_status_unknown',
] as const;
export type MappingFailureReason = (typeof MAPPING_FAILURE_REASONS)[number];

/** Audit record of a denied mapping. Kept for review; never used to grant access. */
export const mappingFailureSchema = z.strictObject({
  ...entraUserKeySchema.shape,
  at: isoTime,
  reason: z.enum(MAPPING_FAILURE_REASONS),
  /** The rule that was being applied when the mapping was denied. */
  method: z.enum(MAPPING_METHODS).optional(),
  /** Number of Moodle accounts that matched (for ambiguous matches). */
  candidates: z.number().int().nonnegative().max(1_000).optional(),
  accountType: z.enum(['member', 'guest']).optional(),
});
export type MappingFailure = z.output<typeof mappingFailureSchema>;

/** The claims last used to map a user, so administrators can re-run the mapping. */
export const identityObservationSchema = z.strictObject({
  ...entraUserKeySchema.shape,
  email: z.string().max(320).optional(),
  emailAsIssued: z.string().max(320).optional(),
  userPrincipalName: z.string().max(320).optional(),
  userPrincipalNameSource: z.enum(['upn', 'preferred_username']).optional(),
  accountType: z.enum(['member', 'guest']).optional(),
  lastSeenAt: isoTime,
});
export type IdentityObservation = z.output<typeof identityObservationSchema>;

/** The mapping inputs stored in an observation (the same claims, re-used by admin commands). */
export function observedClaims(observation: IdentityObservation): {
  readonly tenantId: string;
  readonly objectId: string;
  readonly email?: string;
  readonly emailAsIssued?: string;
  readonly userPrincipalName?: string;
  readonly userPrincipalNameSource?: 'upn' | 'preferred_username';
  readonly accountType?: 'member' | 'guest';
} {
  return {
    tenantId: observation.tenantId,
    objectId: observation.objectId,
    ...(observation.email === undefined ? {} : { email: observation.email }),
    ...(observation.emailAsIssued === undefined
      ? {}
      : { emailAsIssued: observation.emailAsIssued }),
    ...(observation.userPrincipalName === undefined
      ? {}
      : { userPrincipalName: observation.userPrincipalName }),
    ...(observation.userPrincipalNameSource === undefined
      ? {}
      : { userPrincipalNameSource: observation.userPrincipalNameSource }),
    ...(observation.accountType === undefined ? {} : { accountType: observation.accountType }),
  };
}

/** Cached authorisation fetched before `at` must not be used (for one user, or for all). */
export const invalidationSchema = z.strictObject({
  scope: z.union([z.literal('all'), z.strictObject(entraUserKeySchema.shape)]),
  at: isoTime,
  reason: z.enum(['admin', 'mapping_changed', 'enrolment_sync']),
});
export type Invalidation = z.output<typeof invalidationSchema>;

/** The courses the enrolment sync job last saw for a user, to detect revocations. */
export const enrolmentSnapshotSchema = z.strictObject({
  ...entraUserKeySchema.shape,
  courseIds: z.array(courseId).max(1_000),
  syncedAt: isoTime,
});
export type EnrolmentSnapshot = z.output<typeof enrolmentSnapshotSchema>;

export { actor as actorSchema, courseId as courseIdSchema, moodleUserId as moodleUserIdSchema };
