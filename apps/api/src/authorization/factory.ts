import { resolve } from 'node:path';

import {
  createMoodleServices,
  loadMoodleSettings,
  type FetchFn,
  type MoodleClient,
} from '@ehub/moodle-client';
import {
  authorizationConfigSchema,
  cleanEnvironment,
  loadConfig,
  type AuthorizationConfig,
  type EnvironmentSource,
  type Logger,
} from '@ehub/shared';

import { InMemoryAuthorizationCache, type AuthorizationCache } from './authorizationCache.js';
import { AuthorizedCourseService } from './authorizedCourseService.js';
import { EnrolmentSyncJob } from './enrolmentSyncJob.js';
import { FileIdentityMappingRepository } from './fileIdentityMappingRepository.js';
import type { IdentityMappingRepository } from './identityMappingRepository.js';
import { MoodleEnrollmentService } from './moodleEnrollmentService.js';
import { MoodleIdentityResolver } from './moodleIdentityResolver.js';

export type AuthorizationMoodle = Pick<MoodleClient, 'getUsersByField' | 'getUserCourses'>;

export interface AuthorizationDependencies {
  readonly env: EnvironmentSource;
  /** For tests: replaces the Moodle client built from MOODLE_* settings. */
  readonly moodle?: AuthorizationMoodle;
  /** For tests: the HTTP transport of the real Moodle client. */
  readonly moodleFetch?: FetchFn;
  /** For tests: replaces the file store under IDENTITY_STATE_DIR. */
  readonly identityRepository?: IdentityMappingRepository;
}

export interface AuthorizationServices {
  readonly config: AuthorizationConfig;
  readonly repository: IdentityMappingRepository;
  readonly resolver: MoodleIdentityResolver;
  readonly enrolments: MoodleEnrollmentService;
  readonly cache: AuthorizationCache;
  readonly courses: AuthorizedCourseService;
  readonly syncJob: EnrolmentSyncJob;
  /** The Moodle client (or test double), for readiness probes. */
  readonly moodle: AuthorizationMoodle;
}

/** Moodle-based authorisation is used when the Moodle service token is configured. */
export function moodleAuthorizationConfigured(dependencies: AuthorizationDependencies): boolean {
  return (
    dependencies.moodle !== undefined ||
    cleanEnvironment(dependencies.env)['MOODLE_TOKEN'] !== undefined
  );
}

export function createAuthorizationServices(
  dependencies: AuthorizationDependencies,
  logger: Logger,
  options: { readonly mockCourseIds?: readonly number[] } = {},
): AuthorizationServices {
  const config = loadConfig(authorizationConfigSchema, dependencies.env);
  const moodle =
    dependencies.moodle ??
    createMoodleServices(loadMoodleSettings(dependencies.env), {
      logger: logger.child({ component: 'moodle' }),
      ...(dependencies.moodleFetch === undefined ? {} : { fetch: dependencies.moodleFetch }),
    }).client;
  const repository =
    dependencies.identityRepository ??
    new FileIdentityMappingRepository({ directory: resolve(config.IDENTITY_STATE_DIR) });
  const resolver = new MoodleIdentityResolver({
    moodle,
    repository,
    emailMatching: config.IDENTITY_EMAIL_MATCHING,
    upnRule: config.IDENTITY_UPN_USERNAME_RULE,
    upnDomains: config.IDENTITY_UPN_DOMAINS ?? [],
    logger,
  });
  const enrolments = new MoodleEnrollmentService(moodle);
  const cache = new InMemoryAuthorizationCache({
    ttlMs: config.AUTHZ_CACHE_TTL_SECONDS * 1_000,
    maxEntries: config.AUTHZ_CACHE_MAX_ENTRIES,
    invalidations: repository,
    invalidationPollMs: config.AUTHZ_INVALIDATION_POLL_SECONDS * 1_000,
    logger,
  });
  const courses = new AuthorizedCourseService({
    resolver,
    enrolments,
    cache,
    staleGraceMs: config.AUTHZ_STALE_GRACE_SECONDS * 1_000,
    ...(options.mockCourseIds === undefined ? {} : { mockCourseIds: options.mockCourseIds }),
    nodeEnv: config.NODE_ENV,
    logger,
  });
  const syncJob = new EnrolmentSyncJob({ repository, resolver, enrolments, logger });
  return { config, repository, resolver, enrolments, cache, courses, syncJob, moodle };
}
