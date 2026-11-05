import type { Logger } from '@ehub/shared';

import { AuthorizationUnavailableError } from './errors.js';
import type { IdentityMappingRepository } from './identityMappingRepository.js';
import type { EntraIdentityClaims, MoodleIdentityResolver } from './moodleIdentityResolver.js';
import type { MoodleEnrollmentService } from './moodleEnrollmentService.js';
import { observedClaims, userKeyString, type EntraUserKey } from './records.js';

export interface EnrolmentSyncResult {
  readonly users: number;
  /** Users whose courses or mapping changed; their cached authorisation was invalidated. */
  readonly changed: number;
  readonly unchanged: number;
  /** Users who no longer map to an active Moodle account (included in `changed` if they had courses). */
  readonly denied: number;
  /** Users Moodle could not be asked about; left as they were. */
  readonly errors: number;
}

export interface EnrolmentSyncJobOptions {
  readonly repository: IdentityMappingRepository;
  readonly resolver: Pick<MoodleIdentityResolver, 'resolve'>;
  readonly enrolments: Pick<MoodleEnrollmentService, 'coursesFor'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly concurrency?: number;
}

function sameCourses(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Revocation by enrolment sync (`pnpm authorization sync`, run on a schedule): re-reads Moodle
 * for every known user (explicit mappings and users who have signed in), compares the courses
 * with the last snapshot, and writes an invalidation for each user whose access changed, so
 * the API drops their cached authorisation within its poll interval instead of waiting for the
 * TTL. A user seen for the first time is invalidated too, since the API may hold an older view.
 */
export class EnrolmentSyncJob {
  readonly #options: EnrolmentSyncJobOptions;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: EnrolmentSyncJobOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'enrolment-sync' });
    this.#now = options.now ?? (() => new Date());
  }

  async run(): Promise<EnrolmentSyncResult> {
    const { repository } = this.#options;
    const users = new Map<string, EntraIdentityClaims>();
    for (const mapping of await repository.listMappings()) {
      users.set(userKeyString(mapping), { tenantId: mapping.tenantId, objectId: mapping.objectId });
    }
    for (const observation of await repository.listObservations()) {
      users.set(userKeyString(observation), observedClaims(observation));
    }

    let changed = 0;
    let unchanged = 0;
    let denied = 0;
    let errors = 0;
    const queue = [...users.values()];
    const worker = async (): Promise<void> => {
      for (let claims = queue.shift(); claims !== undefined; claims = queue.shift()) {
        const key: EntraUserKey = { tenantId: claims.tenantId, objectId: claims.objectId };
        try {
          const outcome = await this.#syncUser(key, claims);
          if (outcome.changed) {
            changed += 1;
          } else {
            unchanged += 1;
          }
          if (outcome.denied) {
            denied += 1;
          }
        } catch (error) {
          errors += 1;
          this.#logger.warn('Enrolment sync skipped a user.', {
            reason: error instanceof AuthorizationUnavailableError ? error.reason : 'error',
            errorType: error instanceof Error ? error.name : typeof error,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, this.#options.concurrency ?? 2) }, () => worker()),
    );
    const result = { users: users.size, changed, unchanged, denied, errors };
    this.#logger.info('Enrolment sync completed.', { ...result });
    return result;
  }

  async #syncUser(
    key: EntraUserKey,
    claims: EntraIdentityClaims,
  ): Promise<{ readonly changed: boolean; readonly denied: boolean }> {
    const { repository } = this.#options;
    const previous = await repository.getSnapshot(key);
    const resolution = await this.#options.resolver.resolve(claims, { audit: false });
    const at = this.#now().toISOString();
    if (resolution.status === 'denied') {
      if (previous === undefined) {
        return { changed: false, denied: true };
      }
      await repository.addInvalidation({ scope: key, at, reason: 'enrolment_sync' });
      await repository.deleteSnapshot(key);
      return { changed: true, denied: true };
    }
    const { courseIds } = await this.#options.enrolments.coursesFor(resolution.moodleUserId);
    if (previous !== undefined && sameCourses(previous.courseIds, courseIds)) {
      return { changed: false, denied: false };
    }
    await repository.addInvalidation({ scope: key, at, reason: 'enrolment_sync' });
    await repository.saveSnapshot({ ...key, courseIds: [...courseIds], syncedAt: at });
    return { changed: true, denied: false };
  }
}
