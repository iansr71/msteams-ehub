import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
  type CommandDefinition,
} from '@ehub/shared';
import { isSearchServiceError } from '@ehub/shared/search';
import { z } from 'zod';

import { SyncSelectionError } from '../jobs/syncContext.js';
import {
  deleteStaleResources,
  fullSync,
  incrementalSync,
  retryFailedResources,
  syncCourse,
  syncResource,
  type RunOptions,
} from '../jobs/syncJobs.js';
import { renderSyncReportText, type SyncReport } from '../jobs/syncReport.js';
import { finalizeOutput, renderJson, sanitizeText } from '../moodle/diagnosticOutput.js';
import { SyncStateCorruptError } from '../state/syncStateRepository.js';
import type { SyncServices } from '../jobs/syncContext.js';
import { UsageError, courseIdSchema, parseCommandArgs } from './args.js';
import { describeFailure, renderFailureText } from './moodleServices.js';
import { resourceIdSchema } from './resourcePipeline.js';
import { SyncSetupError, openSyncServices, type SyncCommandDependencies } from './syncServices.js';

interface SyncFailureReport {
  readonly status: 'error';
  readonly error: { readonly category: string; readonly code: string; readonly message: string };
  readonly hint?: string;
}

function describeSyncFailure(error: unknown): SyncFailureReport | undefined {
  if (error instanceof SyncSetupError) {
    return {
      status: 'error',
      error: { category: 'setup', code: error.code, message: error.message },
      hint: error.hint,
    };
  }
  if (error instanceof SyncStateCorruptError) {
    return {
      status: 'error',
      error: { category: 'state', code: error.code, message: error.message },
      hint: 'Restore the file from backup, or move it aside to rebuild state (the next sync re-indexes and reconciles).',
    };
  }
  if (isSearchServiceError(error)) {
    return {
      status: 'error',
      error: { category: 'search', code: error.category, message: error.message },
      hint: 'Run pnpm indexer search:health for details.',
    };
  }
  return undefined;
}

function renderSyncFailureText(report: SyncFailureReport, action: string): string {
  return finalizeOutput(
    [
      `${action} failed: ${report.error.category} / ${sanitizeText(report.error.code, 64)}`,
      `  ${sanitizeText(report.error.message, 300)}`,
      ...(report.hint === undefined ? [] : [`  Hint: ${report.hint}`]),
    ].join('\n'),
  );
}

async function withSyncErrorHandling(
  context: CommandContext,
  action: string,
  body: (json: boolean) => Promise<number>,
): Promise<number> {
  const json = context.args.includes('--json');
  try {
    return await body(json);
  } catch (error) {
    if (error instanceof UsageError || error instanceof SyncSelectionError) {
      context.stdout(sanitizeText(error.message, 300));
      return EXIT_USAGE;
    }
    const syncReport = describeSyncFailure(error);
    if (syncReport !== undefined) {
      context.logger.warn(`${action} failed.`, {
        category: syncReport.error.category,
        code: syncReport.error.code,
      });
      context.stdout(json ? renderJson(syncReport) : renderSyncFailureText(syncReport, action));
      return EXIT_FAILURE;
    }
    const report = describeFailure(error);
    if (report === undefined) {
      throw error;
    }
    context.logger.warn(`${action} failed.`, {
      category: report.error.category,
      code: report.error.code,
    });
    context.stdout(json ? renderJson(report) : renderFailureText(report, action));
    return EXIT_FAILURE;
  }
}

function output(
  context: CommandContext,
  report: SyncReport,
  json: boolean,
  verbose: boolean,
): number {
  context.stdout(json ? renderJson(report) : renderSyncReportText(report, { verbose }));
  return report.status === 'succeeded' ? EXIT_OK : EXIT_FAILURE;
}

const baseFlags = {
  json: z.boolean().optional(),
  verbose: z.boolean().optional(),
  'dry-run': z.boolean().optional(),
};

const flagTypes = {
  json: 'boolean',
  verbose: 'boolean',
  'dry-run': 'boolean',
  force: 'boolean',
  'allow-mass-delete': 'boolean',
  'include-dead-letter': 'boolean',
  verify: 'boolean',
  'course-id': 'string',
  'resource-id': 'string',
} as const;

function runOptions(args: {
  readonly 'dry-run'?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly 'allow-mass-delete'?: boolean | undefined;
  readonly 'include-dead-letter'?: boolean | undefined;
}): RunOptions {
  return {
    dryRun: args['dry-run'] === true,
    force: args.force === true,
    allowMassDelete: args['allow-mass-delete'] === true,
    includeDeadLetter: args['include-dead-letter'] === true,
  };
}

type FlagName = keyof typeof flagTypes;

function isFlagName(name: string): name is FlagName {
  return Object.hasOwn(flagTypes, name);
}

interface SyncCommandSpec<Schema extends z.ZodObject> {
  readonly description: string;
  readonly action: string;
  readonly schema: Schema;
  readonly run: (services: SyncServices, args: z.output<Schema>) => Promise<SyncReport>;
}

function defineSyncCommand<Schema extends z.ZodObject>(
  dependencies: SyncCommandDependencies,
  spec: SyncCommandSpec<Schema>,
): CommandDefinition {
  // Only this command's flags are accepted, so `--course-id` on sync:full is "Unknown option".
  const flags = Object.fromEntries(
    Object.keys(spec.schema.shape)
      .filter(isFlagName)
      .map((name) => [name, flagTypes[name]] as const),
  );
  return {
    description: spec.description,
    run: (context) =>
      withSyncErrorHandling(context, spec.action, async (json) => {
        const args = parseCommandArgs(context.args, flags, spec.schema);
        const services = await openSyncServices(dependencies, context.logger);
        const report = await spec.run(services, args);
        return output(context, report, json, args['verbose'] === true);
      }),
  };
}

export function createSyncCommands(
  dependencies: SyncCommandDependencies,
): Readonly<Record<string, CommandDefinition>> {
  return {
    'sync:full': defineSyncCommand(dependencies, {
      description:
        'Sync every selected course, verify files by hash, remove deleted content [--force] [--allow-mass-delete] [--dry-run] [--verbose] [--json].',
      action: 'Full sync',
      schema: z
        .object({
          ...baseFlags,
          force: z.boolean().optional(),
          'allow-mass-delete': z.boolean().optional(),
        })
        .strict(),
      run: (services, args) => fullSync(services, runOptions(args)),
    }),
    'sync:incremental': defineSyncCommand(dependencies, {
      description:
        'Sync what changed in Moodle since the last run [--force] [--allow-mass-delete] [--dry-run] [--verbose] [--json].',
      action: 'Incremental sync',
      schema: z
        .object({
          ...baseFlags,
          force: z.boolean().optional(),
          'allow-mass-delete': z.boolean().optional(),
        })
        .strict(),
      run: (services, args) => incrementalSync(services, runOptions(args)),
    }),
    'sync:course': defineSyncCommand(dependencies, {
      description:
        'Sync one selected course --course-id <id> [--verify] [--force] [--allow-mass-delete] [--dry-run] [--verbose] [--json].',
      action: 'Course sync',
      schema: z
        .object({
          ...baseFlags,
          force: z.boolean().optional(),
          verify: z.boolean().optional(),
          'allow-mass-delete': z.boolean().optional(),
          'course-id': courseIdSchema,
        })
        .strict(),
      run: (services, args) =>
        syncCourse(services, args['course-id'], {
          ...runOptions(args),
          verify: args.verify === true,
        }),
    }),
    'sync:resource': defineSyncCommand(dependencies, {
      description:
        'Sync one resource --course-id <id> --resource-id <id> [--force] [--dry-run] [--json].',
      action: 'Resource sync',
      schema: z
        .object({
          ...baseFlags,
          force: z.boolean().optional(),
          'course-id': courseIdSchema,
          'resource-id': resourceIdSchema,
        })
        .strict(),
      run: (services, args) =>
        syncResource(services, args['course-id'], args['resource-id'], runOptions(args)),
    }),
    'sync:retry-failed': defineSyncCommand(dependencies, {
      description:
        'Retry transient failures now [--include-dead-letter] [--dry-run] [--verbose] [--json].',
      action: 'Retry of failed resources',
      schema: z.object({ ...baseFlags, 'include-dead-letter': z.boolean().optional() }).strict(),
      run: (services, args) => retryFailedResources(services, runOptions(args)),
    }),
    'sync:reconcile': defineSyncCommand(dependencies, {
      description:
        'Remove chunks of deleted, hidden or unselected content; downloads nothing [--dry-run] [--allow-mass-delete] [--verbose] [--json].',
      action: 'Reconciliation',
      schema: z.object({ ...baseFlags, 'allow-mass-delete': z.boolean().optional() }).strict(),
      run: (services, args) => deleteStaleResources(services, runOptions(args)),
    }),
  };
}
