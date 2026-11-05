import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FileSyncStateRepository,
  openSyncServices,
  type SyncCommandDependencies,
  type SyncReport,
  type SyncServices,
  type SyncStateRepository,
} from '@ehub/indexer';
import { createMoodleServices, loadMoodleSettings, type FetchFn } from '@ehub/moodle-client';
import {
  adminConfigSchema,
  cleanEnvironment,
  loadConfig,
  sanitizeText,
  syncConfigSchema,
  type AdminConfig,
  type EntraAuthConfig,
  type EnvironmentSource,
  type Logger,
} from '@ehub/shared';

import type { AuthorizationServices } from '../authorization/factory.js';
import type { RequestAuthenticator } from '../http/authentication.js';
import { AdminDataService, type CourseNameLookup } from './adminData.js';
import { createAdminHandler, type AdminClientConfig } from './adminHandler.js';
import { configurationSnapshot } from './configurationSnapshot.js';
import { fileAdminStores, type AdminStores } from './events.js';
import { AdminJobRunner, type ManualJob } from './jobRunner.js';

/** The MSAL Browser build served to the page; pinned in package.json. */
export const MSAL_BROWSER_VERSION = '5.25.1';

export function msalBundlePath(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('@azure/msal-browser/package.json');
  const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
  if (version !== MSAL_BROWSER_VERSION) {
    throw new Error(`Expected @azure/msal-browser ${MSAL_BROWSER_VERSION}, found ${version}.`);
  }
  return join(dirname(packageJson), 'lib', 'msal-browser.min.js');
}

/** apps/api/admin-ui, from src/admin (tsx) or dist/admin (built). */
export function adminUiDirectory(): string {
  return fileURLToPath(new URL('../../admin-ui/', import.meta.url));
}

export interface AdminDependencies {
  readonly env: EnvironmentSource;
  readonly cwd?: string;
  /** For tests: the sync state instead of the file store under SYNC_STATE_DIR. */
  readonly syncState?: SyncStateRepository;
  readonly stores?: AdminStores;
  readonly courseNames?: CourseNameLookup;
  /** For tests: replaces running the indexer's jobs. */
  readonly runJob?: (services: SyncServices, job: ManualJob, jobId: string) => Promise<SyncReport>;
  readonly openSyncServices?: () => Promise<SyncServices>;
  readonly syncDependencies?: Omit<SyncCommandDependencies, 'env'>;
  /** For tests: the Moodle client's HTTP transport (course names). */
  readonly moodleFetch?: FetchFn;
}

/** Course names from Moodle (`core_course_get_courses`), for course IDs the caller passes. */
function moodleCourseNames(
  dependencies: AdminDependencies,
  logger: Logger,
): CourseNameLookup | undefined {
  if (cleanEnvironment(dependencies.env)['MOODLE_TOKEN'] === undefined) {
    return undefined;
  }
  const { client } = createMoodleServices(loadMoodleSettings(dependencies.env), {
    logger: logger.child({ component: 'moodle' }),
    ...(dependencies.moodleFetch === undefined ? {} : { fetch: dependencies.moodleFetch }),
  });
  return async (courseIds) => {
    const courses = await client.getCourses(courseIds);
    return new Map(courses.map((course) => [course.id, sanitizeText(course.fullname, 200)]));
  };
}

export interface AdminArea {
  readonly handler: ReturnType<typeof createAdminHandler>;
  readonly stores: AdminStores;
  readonly runner: AdminJobRunner;
  readonly config: AdminConfig;
  readonly clientMode: AdminClientConfig['mode'];
  /** The sync state the area reads (readiness and sync gauges). */
  readonly syncState: SyncStateRepository;
  readonly tenantId: string;
  close(): void;
}

export class AdminSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminSetupError';
  }
}

/**
 * Builds the administration area for `pnpm api serve`. Production requires Entra sign-in with
 * the admin page's own app registration; development may use the mock identity instead.
 */
export function createAdminArea(options: {
  readonly dependencies: AdminDependencies;
  readonly authenticator: RequestAuthenticator;
  readonly entra: EntraAuthConfig | undefined;
  readonly authorization: AuthorizationServices | undefined;
  readonly mockUserId: string | undefined;
  readonly logger: Logger;
}): AdminArea {
  const { dependencies, entra, logger } = options;
  const config = loadConfig(adminConfigSchema, dependencies.env);
  const sync = loadConfig(syncConfigSchema, dependencies.env);
  const base = dependencies.cwd ?? dependencies.env['INIT_CWD'] ?? process.cwd();

  let clientConfig: AdminClientConfig;
  if (entra !== undefined && config.ADMIN_SPA_CLIENT_ID !== undefined) {
    if (!entra.ENTRA_ALLOWED_CLIENT_APP_IDS.includes(config.ADMIN_SPA_CLIENT_ID.toLowerCase())) {
      throw new AdminSetupError(
        'ADMIN_SPA_CLIENT_ID must also be listed in ENTRA_ALLOWED_CLIENT_APP_IDS (docs/admin.md).',
      );
    }
    const resource = entra.ENTRA_API_APP_ID_URI ?? `api://${entra.ENTRA_API_CLIENT_ID}`;
    clientConfig = {
      mode: 'msal',
      clientId: config.ADMIN_SPA_CLIENT_ID,
      authority: `${entra.ENTRA_AUTHORITY_HOST.replace(/\/+$/, '')}/${entra.AZURE_TENANT_ID}`,
      scopes: [`${resource}/${entra.ENTRA_API_SCOPE}`],
    };
  } else if (options.authenticator.mode.includes('dev-mock') && options.mockUserId !== undefined) {
    clientConfig = { mode: 'dev-mock', mockUserId: options.mockUserId };
  } else {
    clientConfig = { mode: 'unavailable' };
  }
  if (config.NODE_ENV === 'production' && clientConfig.mode !== 'msal') {
    throw new AdminSetupError(
      'In production the administration area needs Entra sign-in and ADMIN_SPA_CLIENT_ID (docs/admin.md).',
    );
  }

  const state =
    dependencies.syncState ??
    new FileSyncStateRepository({ directory: resolve(base, sync.SYNC_STATE_DIR) });
  const stores = dependencies.stores ?? fileAdminStores(resolve(base, config.ADMIN_STATE_DIR));
  const runner = new AdminJobRunner({
    openServices:
      dependencies.openSyncServices ??
      (() =>
        openSyncServices(
          { ...dependencies.syncDependencies, env: dependencies.env, cwd: base },
          logger,
        )),
    logger,
    ...(dependencies.runJob === undefined ? {} : { run: dependencies.runJob }),
  });
  const data = new AdminDataService({
    state,
    selection: {
      tenantId: sync.AZURE_TENANT_ID,
      courseIds: sync.SYNC_ALL_COURSES ? undefined : (sync.SYNC_COURSE_IDS ?? []),
      allCourses: sync.SYNC_ALL_COURSES,
      leaseTtlMs: sync.SYNC_LEASE_TTL_MS,
    },
    ...(options.authorization === undefined ? {} : { identity: options.authorization.repository }),
    usage: stores.usage,
    audit: stores.audit,
    ...(() => {
      const courseNames = dependencies.courseNames ?? moodleCourseNames(dependencies, logger);
      return courseNames === undefined ? {} : { courseNames };
    })(),
    runner: () => runner.status(),
    logger,
  });
  const authorization = options.authorization;
  const handler = createAdminHandler({
    authenticator: options.authenticator,
    data,
    runner,
    ...(authorization === undefined
      ? {}
      : {
          identity: {
            repository: authorization.repository,
            resolver: authorization.resolver,
            invalidate: (key) => {
              if (key === 'all') {
                authorization.cache.invalidateAll();
              } else {
                authorization.cache.invalidate(key);
              }
            },
            tenantId: (entra?.AZURE_TENANT_ID ?? sync.AZURE_TENANT_ID).toLowerCase(),
          },
        }),
    audit: stores.audit,
    configuration: () => configurationSnapshot(dependencies.env),
    clientConfig,
    ...(config.ADMIN_PUBLIC_ORIGIN === undefined
      ? {}
      : { publicOrigin: config.ADMIN_PUBLIC_ORIGIN }),
    authorityOrigin: new URL(entra?.ENTRA_AUTHORITY_HOST ?? 'https://login.microsoftonline.com')
      .origin,
    uiDirectory: adminUiDirectory(),
    msalBundlePath: msalBundlePath(),
    logger,
  });

  // Retention: prune at start and daily. Failures are logged; they never stop the API.
  const prune = () => {
    for (const store of [stores.audit, stores.usage]) {
      store.prune(config.ADMIN_RETENTION_DAYS).catch((error: unknown) => {
        logger.warn('Could not prune administration records.', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });
    }
  };
  prune();
  const timer = setInterval(prune, 86_400_000);
  timer.unref();

  return {
    handler,
    stores,
    runner,
    config,
    clientMode: clientConfig.mode,
    syncState: state,
    tenantId: sync.AZURE_TENANT_ID,
    close: () => {
      clearInterval(timer);
    },
  };
}
