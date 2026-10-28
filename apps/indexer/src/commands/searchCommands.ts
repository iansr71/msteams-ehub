import {
  ConfigValidationError,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  azureSearchConfigSchema,
  loadConfig,
  type CommandContext,
  type CommandDefinition,
  type EnvironmentSource,
  type Logger,
} from '@ehub/shared';
import {
  MissingPrincipalsError,
  createSearchIndexClient,
  isSearchServiceError,
  type SearchClientSettings,
  type SearchErrorCategory,
  type SearchIndexClient,
} from '@ehub/shared/search';
import { z } from 'zod';

import { finalizeOutput, renderJson, sanitizeText } from '../moodle/diagnosticOutput.js';
import {
  renderCreateIndexText,
  renderHealthText,
  renderValidationText,
} from '../search/searchDiagnostics.js';
import { UsageError, parseCommandArgs } from './args.js';

/** Injection point: tests supply a client wired to a fake service. */
export interface SearchCommandDependencies {
  readonly env: EnvironmentSource;
  readonly createClient?: (
    settings: SearchClientSettings,
    logger: Logger,
  ) => Promise<SearchIndexClient>;
}

const HINTS: Partial<Record<SearchErrorCategory | 'configuration', string>> = {
  configuration: 'Set the listed variables in .env (local) or Key Vault / app settings (Azure).',
  authentication:
    'Locally, check AZURE_SEARCH_API_KEY. In Azure, check the Managed Identity and that the search service allows Microsoft Entra ID authentication (API access control: "Both" or "Role-based").',
  authorization:
    'Grant the identity "Search Service Contributor" (index management) and "Search Index Data Contributor" (documents) on the search service.',
  not_found: 'Check AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_INDEX_NAME.',
  precondition_failed:
    'The index was created or changed by someone else while this ran. Run search:validate-index and retry.',
  network:
    'Could not reach the search service. Check AZURE_SEARCH_ENDPOINT, DNS, firewall rules and private endpoints.',
  timeout:
    'The search service did not respond in time. Retry, or raise AZURE_SEARCH_REQUEST_TIMEOUT_MS.',
  throttled:
    'The search service is throttling requests. Retry later or reduce indexing concurrency.',
  unavailable: 'The search service is temporarily unavailable. Retry later.',
  invalid_request:
    'The service rejected the request. For index creation this usually means the tier does not support a feature (e.g. semantic ranking: set AZURE_SEARCH_SEMANTIC_ENABLED=false).',
};

interface SearchFailureReport {
  readonly status: 'error';
  readonly error: {
    readonly category: string;
    readonly message: string;
    readonly operation?: string;
    readonly httpStatus?: number;
    readonly serviceCode?: string;
    readonly problems?: readonly string[];
  };
  readonly hint?: string;
}

function describeSearchFailure(error: unknown): SearchFailureReport | undefined {
  if (error instanceof ConfigValidationError) {
    return {
      status: 'error',
      error: {
        category: 'configuration',
        message: 'Azure AI Search configuration is missing or invalid.',
        problems: error.issues.map((issue) => `${issue.variable}: ${issue.message}`),
      },
      ...(HINTS.configuration === undefined ? {} : { hint: HINTS.configuration }),
    };
  }
  if (isSearchServiceError(error)) {
    const hint = HINTS[error.category];
    return {
      status: 'error',
      error: {
        category: error.category,
        message: error.message,
        operation: error.operation,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        ...(error.serviceCode === undefined ? {} : { serviceCode: error.serviceCode }),
      },
      ...(hint === undefined ? {} : { hint }),
    };
  }
  if (error instanceof MissingPrincipalsError) {
    return { status: 'error', error: { category: 'access_denied', message: error.message } };
  }
  return undefined;
}

function renderFailureText(report: SearchFailureReport, action: string): string {
  const lines = [
    `${action} failed: ${sanitizeText(report.error.category, 40)}`,
    `  ${sanitizeText(report.error.message, 400)}`,
  ];
  if (report.error.httpStatus !== undefined) {
    lines.push(`  HTTP status: ${String(report.error.httpStatus)}`);
  }
  for (const problem of report.error.problems ?? []) {
    lines.push(`  - ${sanitizeText(problem)}`);
  }
  if (report.hint !== undefined) {
    lines.push(`  Hint: ${report.hint}`);
  }
  return finalizeOutput(lines.join('\n'));
}

async function withSearchErrorHandling(
  context: CommandContext,
  action: string,
  body: (json: boolean) => Promise<number>,
): Promise<number> {
  const json = context.args.includes('--json');
  try {
    return await body(json);
  } catch (error) {
    if (error instanceof UsageError) {
      context.stdout(sanitizeText(error.message, 200));
      return EXIT_USAGE;
    }
    const report = describeSearchFailure(error);
    if (report === undefined) {
      throw error;
    }
    context.logger.warn(`${action} failed.`, {
      category: report.error.category,
      operation: report.error.operation,
      httpStatus: report.error.httpStatus,
    });
    context.stdout(json ? renderJson(report) : renderFailureText(report, action));
    return EXIT_FAILURE;
  }
}

/** Validates AZURE_SEARCH_* (names only on failure) and builds the client. */
export async function openSearchClient(
  dependencies: SearchCommandDependencies,
  logger: Logger,
): Promise<SearchIndexClient> {
  const settings = loadConfig(azureSearchConfigSchema, dependencies.env);
  const create =
    dependencies.createClient ??
    ((resolved: SearchClientSettings, log: Logger) =>
      createSearchIndexClient(resolved, { logger: log }));
  return create(settings, logger);
}

const jsonOnly = z.object({ json: z.boolean().optional() }).strict();
const createArgs = z
  .object({
    json: z.boolean().optional(),
    'apply-compatible-changes': z.boolean().optional(),
  })
  .strict();

export function createSearchCreateIndexCommand(
  dependencies: SearchCommandDependencies,
): CommandDefinition {
  return {
    description:
      'Create the search index if missing; never deletes [--apply-compatible-changes] [--json].',
    run: (context) =>
      withSearchErrorHandling(context, 'Search index creation', async () => {
        const args = parseCommandArgs(
          context.args,
          { json: 'boolean', 'apply-compatible-changes': 'boolean' },
          createArgs,
        );
        const client = await openSearchClient(dependencies, context.logger);
        const result = await client.createOrUpdateIndex({
          applyCompatibleChanges: args['apply-compatible-changes'] === true,
        });
        context.logger.info('Search index create-or-update completed.', {
          indexName: client.indexName,
          outcome: result.outcome,
          differences: result.validation.differences.length,
        });
        context.stdout(
          args.json === true
            ? renderJson({ indexName: client.indexName, ...result })
            : renderCreateIndexText(client.indexName, result),
        );
        return result.outcome === 'created' ||
          result.outcome === 'unchanged' ||
          result.outcome === 'updated'
          ? EXIT_OK
          : EXIT_FAILURE;
      }),
  };
}

export function createSearchValidateIndexCommand(
  dependencies: SearchCommandDependencies,
): CommandDefinition {
  return {
    description: 'Compare the deployed index schema with this version [--json].',
    run: (context) =>
      withSearchErrorHandling(context, 'Search index validation', async () => {
        const args = parseCommandArgs(context.args, { json: 'boolean' }, jsonOnly);
        const client = await openSearchClient(dependencies, context.logger);
        const result = await client.validateIndexSchema();
        context.logger.info('Search index validated.', {
          indexName: result.indexName,
          status: result.status,
          differences: result.differences.length,
        });
        context.stdout(args.json === true ? renderJson(result) : renderValidationText(result));
        return result.status === 'match' ? EXIT_OK : EXIT_FAILURE;
      }),
  };
}

export function createSearchHealthCommand(
  dependencies: SearchCommandDependencies,
): CommandDefinition {
  return {
    description: 'Check the search service and index (counts only) [--json].',
    run: (context) =>
      withSearchErrorHandling(context, 'Search health check', async () => {
        const args = parseCommandArgs(context.args, { json: 'boolean' }, jsonOnly);
        const client = await openSearchClient(dependencies, context.logger);
        const report = await client.healthCheck();
        context.logger.info('Search health check completed.', {
          status: report.status,
          authMode: report.authMode,
          latencyMs: report.latencyMs,
        });
        const hint = report.failure === undefined ? undefined : HINTS[report.failure.category];
        context.stdout(
          args.json === true
            ? renderJson(hint === undefined ? report : { ...report, hint })
            : renderHealthText(report, hint),
        );
        return report.status === 'unhealthy' ? EXIT_FAILURE : EXIT_OK;
      }),
  };
}

export function createSearchCommands(
  dependencies: SearchCommandDependencies,
): Readonly<Record<string, CommandDefinition>> {
  return {
    'search:create-index': createSearchCreateIndexCommand(dependencies),
    'search:validate-index': createSearchValidateIndexCommand(dependencies),
    'search:health': createSearchHealthCommand(dependencies),
  };
}
