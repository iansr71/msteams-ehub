import {
  adminConfigSchema,
  apiServerConfigSchema,
  authorizationConfigSchema,
  cleanEnvironment,
  retrievalConfigSchema,
  SECRET_ENV_KEYS,
  syncConfigSchema,
  type EnvironmentSource,
} from '@ehub/shared';
import type { z } from 'zod';

import {
  MAX_FAILURE_RECORDS,
  INVALIDATION_RETENTION_MS,
} from '../authorization/identityMappingRepository.js';

/*
 * The configuration page: an explicit allow-list of non-secret settings, read from the same
 * validated configuration the services use. Read-only: settings change in the app's
 * configuration (environment or Key Vault references), not from the page.
 */

type Value = string | number | boolean | readonly number[] | null;

export interface ConfigurationSection {
  readonly title: string;
  /** False when the group is not configured or invalid; values are then omitted. */
  readonly configured: boolean;
  readonly settings: readonly { readonly name: string; readonly value: Value }[];
}

function load<S extends z.ZodType>(schema: S, env: EnvironmentSource): z.output<S> | undefined {
  const parsed = schema.safeParse(cleanEnvironment(env));
  return parsed.success ? parsed.data : undefined;
}

function section(
  title: string,
  config: Record<string, unknown> | undefined,
  names: readonly string[],
  extra: readonly { readonly name: string; readonly value: Value }[] = [],
): ConfigurationSection {
  return {
    title,
    configured: config !== undefined,
    settings: [
      ...(config === undefined
        ? []
        : names.map((name) => {
            const value = config[name];
            return {
              name,
              value:
                typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                  ? value
                  : Array.isArray(value) && value.every((item) => typeof item === 'number')
                    ? value
                    : null,
            };
          })),
      ...extra,
    ],
  };
}

export const SECRET_SETTING_NAMES: ReadonlySet<string> = new Set(SECRET_ENV_KEYS);

export function configurationSnapshot(env: EnvironmentSource): readonly ConfigurationSection[] {
  const cleaned = cleanEnvironment(env);
  const sync = load(syncConfigSchema, env);
  const retrieval = load(retrievalConfigSchema, env);
  const authorization = load(authorizationConfigSchema, env);
  const admin = load(adminConfigSchema, env);
  const api = load(apiServerConfigSchema, env);
  const sections = [
    section('Included courses', sync, [
      'SYNC_COURSE_IDS',
      'SYNC_ALL_COURSES',
      'SYNC_INCLUDE_HIDDEN',
    ]),
    section('Retrieval', retrieval, [
      'RETRIEVAL_TOP_K',
      'RETRIEVAL_CANDIDATE_COUNT',
      'RETRIEVAL_MAX_CHUNKS_PER_RESOURCE',
      'RETRIEVAL_MIN_SCORE',
      'RETRIEVAL_MIN_RERANKER_SCORE',
      'RETRIEVAL_SEMANTIC_RANKING',
    ]),
    section('Synchronisation', sync, [
      'SYNC_MAX_ATTEMPTS',
      'SYNC_RETRY_BASE_DELAY_MS',
      'SYNC_RETRY_MAX_DELAY_MS',
      'SYNC_LEASE_TTL_MS',
      'SYNC_MAX_DELETE_FRACTION',
      'SYNC_MAX_DELETE_MINIMUM',
    ]),
    section(
      'Features',
      api,
      ['NODE_ENV', 'API_DEV_MOCK_IDENTITY'],
      [
        { name: 'MOODLE_COURSE_AUTHORIZATION', value: cleaned['MOODLE_TOKEN'] !== undefined },
        { name: 'ENTRA_SIGN_IN', value: cleaned['ENTRA_API_CLIENT_ID'] !== undefined },
        { name: 'ADMIN_UI_ENABLED', value: admin?.ADMIN_UI_ENABLED ?? false },
        { name: 'IDENTITY_EMAIL_MATCHING', value: authorization?.IDENTITY_EMAIL_MATCHING ?? null },
        {
          name: 'IDENTITY_UPN_USERNAME_RULE',
          value: authorization?.IDENTITY_UPN_USERNAME_RULE ?? null,
        },
      ],
    ),
    section('Logging', api, ['LOG_LEVEL']),
    section(
      'Retention and caching',
      authorization,
      ['AUTHZ_CACHE_TTL_SECONDS', 'AUTHZ_STALE_GRACE_SECONDS', 'AUTHZ_CACHE_MAX_ENTRIES'],
      [
        { name: 'ADMIN_RETENTION_DAYS', value: admin?.ADMIN_RETENTION_DAYS ?? null },
        { name: 'IDENTITY_FAILURE_RECORDS_KEPT', value: MAX_FAILURE_RECORDS },
        { name: 'INVALIDATIONS_KEPT_HOURS', value: INVALIDATION_RETENTION_MS / 3_600_000 },
      ],
    ),
  ];
  // Defence in depth: the allow-list above must never name a secret.
  return sections.map((entry) => ({
    ...entry,
    settings: entry.settings.filter((setting) => !SECRET_SETTING_NAMES.has(setting.name)),
  }));
}
