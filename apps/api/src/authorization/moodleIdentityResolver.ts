import type { MoodleClient, MoodleUser } from '@ehub/moodle-client';
import { MoodleError } from '@ehub/moodle-client';
import { getTelemetry, type Logger, type UpnUsernameRule } from '@ehub/shared';

import type { IdentityMappingRepository } from './identityMappingRepository.js';
import type { MappingFailureReason, MappingMethod } from './records.js';
import { AuthorizationUnavailableError } from './errors.js';

/** The validated token claims mapping may use. Built only from a validated Entra token. */
export interface EntraIdentityClaims {
  readonly tenantId: string;
  readonly objectId: string;
  /** Lower-cased email claim. */
  readonly email?: string;
  /** The email claim as issued, before lower-casing. */
  readonly emailAsIssued?: string;
  readonly userPrincipalName?: string;
  readonly userPrincipalNameSource?: 'upn' | 'preferred_username';
  readonly accountType?: 'member' | 'guest';
}

export type IdentityResolution =
  | { readonly status: 'mapped'; readonly moodleUserId: number; readonly method: MappingMethod }
  | {
      readonly status: 'denied';
      readonly reason: MappingFailureReason;
      readonly method?: MappingMethod;
      readonly candidates?: number;
    };

export type MoodleUserLookup = Pick<MoodleClient, 'getUsersByField'>;

export interface MoodleIdentityResolverOptions {
  readonly moodle: MoodleUserLookup;
  readonly repository: IdentityMappingRepository;
  readonly emailMatching: boolean;
  readonly upnRule: UpnUsernameRule;
  /** Lower-case domains the UPN rule applies to. */
  readonly upnDomains: readonly string[];
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** Moodle usernames are lower-case; Moodle rejects a lookup value it would have to clean. */
const MOODLE_USERNAME = /^[a-z0-9._@-]{1,100}$/;

function moodleUsernameFor(
  upn: string,
  rule: UpnUsernameRule,
  domains: readonly string[],
): string | undefined {
  const lower = upn.toLowerCase();
  const at = lower.lastIndexOf('@');
  // Guest UPNs (name_gmail.com#EXT#@tenant) never match: they are not usernames anyone chose.
  if (at <= 0 || lower.includes('#ext#')) {
    return undefined;
  }
  if (!domains.includes(lower.slice(at + 1))) {
    return undefined;
  }
  const username = rule === 'upn' ? lower : rule === 'upn-local-part' ? lower.slice(0, at) : '';
  return MOODLE_USERNAME.test(username) ? username : undefined;
}

/**
 * Decides which Moodle account a signed-in user is, in a fixed order:
 *
 * 1. an administrator-approved explicit mapping (then nothing else is tried);
 * 2. the token's email claim matching exactly one Moodle account;
 * 3. the token's `upn` claim through the configured username rule;
 * 4. otherwise denied, with an audit record.
 *
 * Ambiguous matches are always denied. Every candidate must be confirmed active by Moodle. A
 * Moodle outage is an error (the caller fails closed), never a denial or a guess.
 */
export class MoodleIdentityResolver {
  readonly #options: MoodleIdentityResolverOptions;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: MoodleIdentityResolverOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'identity-mapping' });
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Resolves and, unless `audit` is false (the admin dry run), records the outcome: an audit
   * record for a denial and the claims used.
   */
  async resolve(
    claims: EntraIdentityClaims,
    options: { readonly audit?: boolean } = {},
  ): Promise<IdentityResolution> {
    const audit = options.audit ?? true;
    const resolution = await getTelemetry().span('identity.resolve', async (span) => {
      const result = await this.#resolve(claims);
      span.set({
        'ehub.outcome': result.status,
        ...(result.method === undefined ? {} : { 'ehub.method': result.method }),
        ...(result.status === 'denied' ? { 'ehub.reason': result.reason } : {}),
        ...(claims.accountType === undefined ? {} : { 'ehub.account_type': claims.accountType }),
      });
      getTelemetry().count('ehub.identity.mappings', {
        status: result.status,
        method: result.method,
        reason: result.status === 'denied' ? result.reason : undefined,
      });
      return result;
    });
    // Logs carry the method or reason only, never email or UPN.
    if (resolution.status === 'mapped') {
      this.#logger.info('Moodle identity resolved.', {
        method: resolution.method,
        accountType: claims.accountType,
      });
    } else {
      this.#logger.warn('Moodle identity mapping denied.', {
        reason: resolution.reason,
        method: resolution.method,
        candidates: resolution.candidates,
        accountType: claims.accountType,
      });
    }
    if (audit) {
      await this.#record(claims, resolution);
    }
    return resolution;
  }

  /** Whether a Moodle account exists and is active, as an explicit mapping would require. */
  async checkAccount(moodleUserId: number): Promise<IdentityResolution> {
    const users = await this.#lookup('id', [String(moodleUserId)]);
    const user = users.find((entry) => entry.id === moodleUserId);
    return user === undefined
      ? { status: 'denied', reason: 'mapped_user_not_found', method: 'explicit' }
      : this.#confirmActive(user, 'explicit');
  }

  async #record(claims: EntraIdentityClaims, resolution: IdentityResolution): Promise<void> {
    const key = { tenantId: claims.tenantId, objectId: claims.objectId };
    const at = this.#now().toISOString();
    try {
      await this.#options.repository.recordObservation({
        ...key,
        ...(claims.email === undefined ? {} : { email: claims.email }),
        ...(claims.emailAsIssued === undefined ? {} : { emailAsIssued: claims.emailAsIssued }),
        ...(claims.userPrincipalName === undefined
          ? {}
          : { userPrincipalName: claims.userPrincipalName }),
        ...(claims.userPrincipalNameSource === undefined
          ? {}
          : { userPrincipalNameSource: claims.userPrincipalNameSource }),
        ...(claims.accountType === undefined ? {} : { accountType: claims.accountType }),
        lastSeenAt: at,
      });
      if (resolution.status === 'denied') {
        await this.#options.repository.recordFailure({
          ...key,
          at,
          reason: resolution.reason,
          ...(resolution.method === undefined ? {} : { method: resolution.method }),
          ...(resolution.candidates === undefined ? {} : { candidates: resolution.candidates }),
          ...(claims.accountType === undefined ? {} : { accountType: claims.accountType }),
        });
      }
    } catch (error) {
      // The audit trail must not decide access: a store failure is logged, the outcome stands.
      this.#logger.error('Could not record the identity mapping outcome.', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  async #resolve(claims: EntraIdentityClaims): Promise<IdentityResolution> {
    let mapping;
    try {
      mapping = await this.#options.repository.getMapping({
        tenantId: claims.tenantId,
        objectId: claims.objectId,
      });
    } catch (error) {
      // Without the store an explicit mapping could be missed, or a removed one honoured.
      throw new AuthorizationUnavailableError('identity_store_unavailable', error);
    }
    if (mapping !== undefined) {
      return await this.checkAccount(mapping.moodleUserId);
    }

    let triedClaim = false;
    if (this.#options.emailMatching && claims.email !== undefined) {
      triedClaim = true;
      const outcome = await this.#byEmail(claims.email, claims.emailAsIssued);
      if (outcome !== undefined) {
        return outcome;
      }
    }

    if (
      this.#options.upnRule !== 'none' &&
      claims.userPrincipalName !== undefined &&
      claims.userPrincipalNameSource === 'upn' &&
      claims.accountType !== 'guest'
    ) {
      const username = moodleUsernameFor(
        claims.userPrincipalName,
        this.#options.upnRule,
        this.#options.upnDomains,
      );
      if (username !== undefined) {
        triedClaim = true;
        const users = (await this.#lookup('username', [username])).filter(
          (user) => user.username === undefined || user.username.toLowerCase() === username,
        );
        if (users.length > 1) {
          return {
            status: 'denied',
            reason: 'ambiguous_username',
            method: 'upn_username',
            candidates: users.length,
          };
        }
        const [user] = users;
        if (user !== undefined) {
          return this.#confirmActive(user, 'upn_username');
        }
      }
    }

    return { status: 'denied', reason: triedClaim ? 'no_match' : 'no_usable_claims' };
  }

  async #byEmail(
    email: string,
    asIssued: string | undefined,
  ): Promise<IdentityResolution | undefined> {
    // Exact-match lookups: case-sensitive databases need the issued form as well.
    const values = [...new Set([email, ...(asIssued === undefined ? [] : [asIssued])])];
    const found = await this.#lookup('email', values);
    // Moodle returns only accounts whose email the service account may see; those are compared
    // here case-insensitively, and duplicates (the same account found twice) are merged.
    const matches = [
      ...new Map(
        found.filter((user) => user.email?.toLowerCase() === email).map((user) => [user.id, user]),
      ).values(),
    ];
    if (matches.length > 1) {
      return {
        status: 'denied',
        reason: 'ambiguous_email',
        method: 'email',
        candidates: matches.length,
      };
    }
    const [user] = matches;
    return user === undefined ? undefined : this.#confirmActive(user, 'email');
  }

  #confirmActive(user: MoodleUser, method: MappingMethod): IdentityResolution {
    // Moodle omits `suspended` when it is a hidden user field; unknown is not active.
    if (user.suspended === undefined) {
      return { status: 'denied', reason: 'moodle_status_unknown', method };
    }
    if (user.suspended || user.auth === 'nologin' || user.confirmed === false) {
      return { status: 'denied', reason: 'moodle_user_suspended', method };
    }
    return { status: 'mapped', moodleUserId: user.id, method };
  }

  async #lookup(field: 'id' | 'email' | 'username', values: string[]): Promise<MoodleUser[]> {
    try {
      return await this.#options.moodle.getUsersByField(field, values);
    } catch (error) {
      // Moodle rejects values its own cleaning would change (e.g. unusual email characters), and
      // the client rejects over-long ones: such a value cannot match any account, so it is no
      // match rather than an outage.
      if (
        error instanceof MoodleError &&
        (error.moodleErrorCode === 'invalidparameter' || error.code === 'invalid_request')
      ) {
        return [];
      }
      throw new AuthorizationUnavailableError('moodle_unavailable', error);
    }
  }
}
