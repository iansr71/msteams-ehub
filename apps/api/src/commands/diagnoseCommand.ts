import { resolve } from 'node:path';

import { FileSyncStateRepository, reportSyncGauges } from '@ehub/indexer';
import {
  EXIT_FAILURE,
  EXIT_OK,
  cleanEnvironment,
  observabilityConfigSchema,
  parseCommandArgs,
  syncConfigSchema,
  type CommandDefinition,
  type HealthReport,
} from '@ehub/shared';
import { z } from 'zod';

import {
  createAuthorizationServices,
  moodleAuthorizationConfigured,
  type AuthorizationDependencies,
} from '../authorization/factory.js';
import { createApiReadiness } from '../health/apiReadiness.js';
import type { DependencyReport } from '../health/readiness.js';
import { openRagService, type AskCommandDependencies } from './askCommand.js';
import { buildApiHealthReport } from './health.js';

export type DiagnoseDependencies = AskCommandDependencies &
  Omit<AuthorizationDependencies, 'env'> & { readonly now?: () => Date };

export interface DiagnosticReport {
  readonly status: 'pass' | 'fail';
  readonly configuration: Pick<HealthReport, 'status' | 'checks'>;
  readonly dependencies: readonly DependencyReport[];
  readonly sync:
    | { readonly status: 'not_configured' }
    | { readonly status: 'unreadable' }
    | {
        readonly status: 'ok';
        readonly lagSeconds: number | null;
        readonly resources: Readonly<Record<string, number>>;
      };
  readonly telemetry: { readonly applicationInsights: 'configured' | 'not_configured' | 'invalid' };
  /** Why live checks could not run (configuration problems), as variable names only. */
  readonly skipped: readonly string[];
}

/**
 * `pnpm api diagnose` (also `pnpm diagnose`): configuration and live dependency checks in one
 * report. Prints names, statuses, failure categories and timings only: never credentials,
 * endpoints or URLs. Exits 1 when configuration fails or a required dependency is down.
 */
export function createDiagnoseCommand(dependencies: DiagnoseDependencies): CommandDefinition {
  return {
    description:
      'Check configuration and every dependency (Moodle, search, embeddings, chat model, state stores) without printing credentials.',
    run: async (context) => {
      parseCommandArgs(
        context.args,
        { json: 'boolean' },
        z.object({ json: z.boolean().optional() }).strict(),
      );
      const { env } = dependencies;
      const health = buildApiHealthReport(env, dependencies.now);
      const skipped: string[] = [];
      let reports: readonly DependencyReport[] = [];
      try {
        const authorizationDependencies: AuthorizationDependencies = {
          env,
          ...(dependencies.moodle === undefined ? {} : { moodle: dependencies.moodle }),
          ...(dependencies.moodleFetch === undefined
            ? {}
            : { moodleFetch: dependencies.moodleFetch }),
          ...(dependencies.identityRepository === undefined
            ? {}
            : { identityRepository: dependencies.identityRepository }),
        };
        const authorization = moodleAuthorizationConfigured(authorizationDependencies)
          ? createAuthorizationServices(authorizationDependencies, context.logger)
          : undefined;
        const { probes } = await openRagService(dependencies, context.logger);
        const readiness = createApiReadiness({ ...probes, authorization, logger: context.logger });
        reports = (await readiness.report({ fresh: true })).dependencies;
      } catch (error) {
        // Configuration problems are already in the configuration section, by variable name.
        skipped.push(
          error instanceof Error && error.name === 'ConfigValidationError'
            ? 'live checks skipped: configuration is incomplete'
            : `live checks skipped: ${error instanceof Error ? error.name : 'error'}`,
        );
      }

      let sync: DiagnosticReport['sync'] = { status: 'not_configured' };
      const syncConfig = syncConfigSchema.safeParse(cleanEnvironment(env));
      if (syncConfig.success) {
        try {
          const state = new FileSyncStateRepository({
            directory: resolve(env['INIT_CWD'] ?? process.cwd(), syncConfig.data.SYNC_STATE_DIR),
          });
          const snapshot = await reportSyncGauges(
            state,
            syncConfig.data.AZURE_TENANT_ID,
            (dependencies.now ?? (() => new Date()))(),
          );
          sync = {
            status: 'ok',
            lagSeconds: snapshot.lagSeconds ?? null,
            resources: snapshot.resources,
          };
        } catch {
          sync = { status: 'unreadable' };
        }
      }

      const observability = observabilityConfigSchema.safeParse(cleanEnvironment(env));
      const telemetry: DiagnosticReport['telemetry'] = {
        applicationInsights: !observability.success
          ? 'invalid'
          : observability.data.APPLICATIONINSIGHTS_CONNECTION_STRING === undefined
            ? 'not_configured'
            : 'configured',
      };
      const failed =
        health.status === 'fail' ||
        skipped.length > 0 ||
        sync.status === 'unreadable' ||
        reports.some((report) => report.required && report.status !== 'up');
      const report: DiagnosticReport = {
        status: failed ? 'fail' : 'pass',
        configuration: { status: health.status, checks: health.checks },
        dependencies: reports,
        sync,
        telemetry,
        skipped,
      };
      context.stdout(JSON.stringify(report, null, 2));
      return failed ? EXIT_FAILURE : EXIT_OK;
    },
  };
}
