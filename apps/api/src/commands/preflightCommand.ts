import { resolve } from 'node:path';

import { FileSyncStateRepository } from '@ehub/indexer';
import {
  EXIT_FAILURE,
  EXIT_OK,
  azureSearchConfigSchema,
  READINESS_SCOPES,
  checkProductionReadiness,
  cleanEnvironment,
  parseCommandArgs,
  renderReadinessText,
  syncConfigSchema,
  type CommandDefinition,
  type ProductionReadinessReport,
  type ReadinessScope,
} from '@ehub/shared';
import {
  SEARCH_TOKEN_SCOPE,
  createDefaultSearchCredential,
  type IndexValidationResult,
  type SearchTokenCredential,
} from '@ehub/shared/search';
import { z } from 'zod';

import {
  createAuthorizationServices,
  moodleAuthorizationConfigured,
  type AuthorizationDependencies,
} from '../authorization/factory.js';
import { createApiReadiness } from '../health/apiReadiness.js';
import type { DependencyReport } from '../health/readiness.js';
import { openRagService } from './askCommand.js';
import type { DiagnoseDependencies } from './diagnoseCommand.js';

/*
 * `pnpm api preflight` (also `pnpm preflight`): the production startup validation Prompt 20
 * requires. It answers one question — would this deployment work right now? — by checking
 * configuration, the settings that must agree with each other, the pilot controls, and then
 * every live dependency, including whether the deployed index still matches this build's schema.
 *
 * It fails closed: anything it could not check counts as a failure, because "we could not tell"
 * is not a reason to let staff loose on an assistant that may be answering from nothing.
 *
 * Key Vault is checked by implication rather than directly. The deployed services never call
 * Key Vault: Container Apps resolves each secret reference with the app's user-assigned managed
 * identity and passes the value as an environment variable (infrastructure/bicep). So a secret
 * that is absent or still a placeholder means the reference, the vault access policy or the
 * identity is wrong, and that is what the configuration findings say. Vault access itself is
 * verified at deployment time by infrastructure/scripts/deploy.sh.
 */

export type LiveCheckStatus = 'pass' | 'fail' | 'skipped';

export interface LiveCheck {
  readonly name: string;
  readonly status: LiveCheckStatus;
  /** Sanitised category or outcome; never a message, URL or credential. */
  readonly detail: string | undefined;
  readonly latencyMs: number | null;
}

export interface PreflightReport {
  readonly status: 'pass' | 'fail';
  readonly checkedAt: string;
  readonly configuration: ProductionReadinessReport;
  readonly live: readonly LiveCheck[];
  readonly indexSchema:
    | { readonly status: 'not_checked'; readonly reason: string }
    | {
        readonly status: IndexValidationResult['status'];
        readonly indexName: string;
        readonly expectedSchemaVersion: number;
        readonly deployedSchemaVersion: number | undefined;
        readonly differences: number;
      };
}

export interface PreflightOptions {
  /** Configuration only: no service is contacted. Used by `pnpm release:verify`. */
  readonly staticOnly?: boolean;
  /** Which deployment the configuration checks are about; the whole rollout by default. */
  readonly scope?: ReadinessScope;
}

export interface PreflightDependencies extends DiagnoseDependencies {
  /** For tests: the credential whose token proves managed identity works. */
  readonly createCredential?: () => Promise<SearchTokenCredential>;
}

const DEPENDENCY_ORDER: readonly string[] = [
  'search',
  'embedding',
  'chat',
  'moodle',
  'state_store',
];

function fromDependency(report: DependencyReport): LiveCheck {
  return {
    name: report.name,
    // A dependency the deployment needs but has not configured is a failure here, unlike in the
    // readiness probe, where "not configured" is a legitimate state for a partial environment.
    status: report.status === 'up' ? 'pass' : 'fail',
    detail: report.status === 'up' ? undefined : (report.category ?? report.status),
    latencyMs: report.latencyMs,
  };
}

async function checkManagedIdentity(dependencies: PreflightDependencies): Promise<LiveCheck> {
  const search = azureSearchConfigSchema.safeParse(cleanEnvironment(dependencies.env));
  if (!search.success) {
    return {
      name: 'managed_identity',
      status: 'fail',
      detail: 'search_configuration_invalid',
      latencyMs: null,
    };
  }
  if (search.data.AZURE_SEARCH_API_KEY !== undefined) {
    // Key authentication is not how production is deployed (the Bicep disables keys), so this
    // is reported as skipped rather than passed: there is no identity to prove.
    return {
      name: 'managed_identity',
      status: 'skipped',
      detail: 'api_key_authentication',
      latencyMs: null,
    };
  }
  const started = Date.now();
  try {
    const credential = await (dependencies.createCredential ?? createDefaultSearchCredential)();
    const token = await credential.getToken(SEARCH_TOKEN_SCOPE);
    const latencyMs = Date.now() - started;
    return token === null || token.token === ''
      ? { name: 'managed_identity', status: 'fail', detail: 'no_token', latencyMs }
      : { name: 'managed_identity', status: 'pass', detail: undefined, latencyMs };
  } catch {
    return {
      name: 'managed_identity',
      status: 'fail',
      detail: 'token_request_failed',
      latencyMs: Date.now() - started,
    };
  }
}

function stateStoreDirectory(dependencies: PreflightDependencies): string | undefined {
  const sync = syncConfigSchema.safeParse(cleanEnvironment(dependencies.env));
  return sync.success
    ? resolve(dependencies.env['INIT_CWD'] ?? process.cwd(), sync.data.SYNC_STATE_DIR)
    : undefined;
}

async function checkSyncState(dependencies: PreflightDependencies): Promise<LiveCheck> {
  const directory = stateStoreDirectory(dependencies);
  if (directory === undefined) {
    return {
      name: 'sync_state',
      status: 'fail',
      detail: 'sync_configuration_invalid',
      latencyMs: null,
    };
  }
  const started = Date.now();
  try {
    await new FileSyncStateRepository({ directory }).listJobs(1);
    return {
      name: 'sync_state',
      status: 'pass',
      detail: undefined,
      latencyMs: Date.now() - started,
    };
  } catch {
    return {
      name: 'sync_state',
      status: 'fail',
      detail: 'unreadable',
      latencyMs: Date.now() - started,
    };
  }
}

/** Builds the report. Exported so tests can score it without going through the CLI. */
export async function runPreflight(
  dependencies: PreflightDependencies,
  logger: Parameters<typeof openRagService>[1],
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const now = dependencies.now ?? (() => new Date());
  const configuration = checkProductionReadiness(dependencies.env, {
    now: now(),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  if (options.staticOnly === true) {
    return {
      status: configuration.status === 'fail' ? 'fail' : 'pass',
      checkedAt: now().toISOString(),
      configuration,
      live: [],
      indexSchema: { status: 'not_checked', reason: 'static_only' },
    };
  }
  const live: LiveCheck[] = [await checkManagedIdentity(dependencies)];
  let indexSchema: PreflightReport['indexSchema'] = {
    status: 'not_checked',
    reason: 'configuration_incomplete',
  };

  try {
    const authorizationDependencies: AuthorizationDependencies = {
      env: dependencies.env,
      ...(dependencies.moodle === undefined ? {} : { moodle: dependencies.moodle }),
      ...(dependencies.moodleFetch === undefined ? {} : { moodleFetch: dependencies.moodleFetch }),
      ...(dependencies.identityRepository === undefined
        ? {}
        : { identityRepository: dependencies.identityRepository }),
    };
    const authorization = moodleAuthorizationConfigured(authorizationDependencies)
      ? createAuthorizationServices(authorizationDependencies, logger)
      : undefined;
    const { probes } = await openRagService(dependencies, logger);
    const readiness = createApiReadiness({ ...probes, authorization, logger });
    const reports = (await readiness.report({ fresh: true })).dependencies;
    for (const name of DEPENDENCY_ORDER) {
      const report = reports.find((entry) => entry.name === name);
      live.push(
        report === undefined
          ? { name, status: 'fail', detail: 'not_checked', latencyMs: null }
          : fromDependency(report),
      );
    }
    const validator = probes.search as Partial<{
      validateIndexSchema(): Promise<IndexValidationResult>;
    }>;
    try {
      if (typeof validator.validateIndexSchema !== 'function') {
        throw new Error('The search client cannot read the deployed index definition.');
      }
      const validation = await validator.validateIndexSchema();
      indexSchema = {
        status: validation.status,
        indexName: validation.indexName,
        expectedSchemaVersion: validation.expectedSchemaVersion,
        deployedSchemaVersion: validation.deployedSchemaVersion,
        differences: validation.differences.length,
      };
    } catch {
      indexSchema = { status: 'not_checked', reason: 'index_unreadable' };
    }
  } catch (error) {
    // The configuration findings already name the variables; this records that nothing live ran.
    live.push({
      name: 'live_checks',
      status: 'fail',
      detail:
        error instanceof Error && error.name === 'ConfigValidationError'
          ? 'configuration_incomplete'
          : 'startup_failed',
      latencyMs: null,
    });
  }

  if (!live.some((check) => check.name === 'sync_state')) {
    live.push(await checkSyncState(dependencies));
  }

  const indexOk = indexSchema.status === 'match' || indexSchema.status === 'compatible-changes';
  const status =
    configuration.status === 'fail' || live.some((check) => check.status === 'fail') || !indexOk
      ? 'fail'
      : 'pass';
  return { status, checkedAt: now().toISOString(), configuration, live, indexSchema };
}

export function renderPreflightText(report: PreflightReport): string {
  if (report.live.length === 0) {
    return [
      renderReadinessText(report.configuration),
      '',
      'Live checks were not run (configuration only).',
      '',
      `Preflight: ${report.status.toUpperCase()} (configuration only).`,
    ].join('\n');
  }
  const lines = [renderReadinessText(report.configuration), '', 'Live checks'];
  for (const check of report.live) {
    const mark = check.status === 'pass' ? '✓' : check.status === 'skipped' ? '–' : '✗';
    const timing = check.latencyMs === null ? '' : ` (${String(check.latencyMs)} ms)`;
    lines.push(
      `${mark} ${check.name.padEnd(18)} ${check.status}${check.detail === undefined ? '' : `: ${check.detail}`}${timing}`,
    );
  }
  lines.push(
    '',
    report.indexSchema.status === 'not_checked'
      ? `✗ index schema      not checked: ${report.indexSchema.reason}`
      : `${report.indexSchema.status === 'match' || report.indexSchema.status === 'compatible-changes' ? '✓' : '✗'} index schema      ${report.indexSchema.status} (expected version ${String(report.indexSchema.expectedSchemaVersion)}, deployed ${String(report.indexSchema.deployedSchemaVersion ?? 'none')}, ${String(report.indexSchema.differences)} difference(s))`,
    '',
    `Preflight: ${report.status.toUpperCase()}.`,
  );
  return lines.join('\n');
}

/**
 * Prints names, statuses and categories only: never credentials, endpoints or URLs. Exits 1 when
 * any check fails, so a deployment pipeline can gate on it.
 */
export function createPreflightCommand(dependencies: PreflightDependencies): CommandDefinition {
  return {
    description:
      'Production startup validation: configuration, pilot controls, live dependencies and index schema [--static] [--scope deployment|apiService|release] [--json]. Exit 1 if anything fails.',
    run: async (context) => {
      const args = parseCommandArgs(
        context.args,
        { json: 'boolean', static: 'boolean', scope: 'string' },
        z
          .object({
            json: z.boolean().optional(),
            static: z.boolean().optional(),
            scope: z.enum(READINESS_SCOPES).optional(),
          })
          .strict(),
      );
      const report = await runPreflight(dependencies, context.logger, {
        ...(args.static === undefined ? {} : { staticOnly: args.static }),
        ...(args.scope === undefined ? {} : { scope: args.scope }),
      });
      context.logger.info('Preflight completed.', {
        status: report.status,
        findings: report.configuration.findings.length,
        indexSchema: report.indexSchema.status,
      });
      context.stdout(
        args.json === true ? JSON.stringify(report, null, 2) : renderPreflightText(report),
      );
      return report.status === 'pass' ? EXIT_OK : EXIT_FAILURE;
    },
  };
}
