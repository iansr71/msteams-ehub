import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  ConfigValidationError,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  azureIdentityConfigShape,
  azureSearchConfigSchema,
  courseIdListSchema,
  embeddingConfigSchema,
  loadConfig,
  parseCommandArgs,
  redactString,
  retrievalConfigSchema,
  sanitizeText,
  type CommandContext,
  type CommandDefinition,
  type EnvironmentSource,
  type Logger,
} from '@ehub/shared';
import {
  EmbeddingError,
  createEmbeddingProvider,
  isEmbeddingError,
  type EmbeddingSettings,
} from '@ehub/shared/embeddings';
import {
  InvalidFilterValueError,
  SEARCH_RESOURCE_TYPES,
  SearchScopeError,
  createSearchIndexClient,
  isSearchServiceError,
  type SearchClientSettings,
} from '@ehub/shared/search';
import { z } from 'zod';

import {
  EvaluationFileError,
  MAX_EVALUATION_FILE_BYTES,
  parseEvaluationFile,
} from '../retrieval/evaluationCases.js';
import { renderEvaluationJson, renderEvaluationText } from '../retrieval/evaluationOutput.js';
import { EvaluationRunner } from '../retrieval/evaluationRunner.js';
import { RetrievalDiagnostics } from '../retrieval/retrievalDiagnostics.js';
import {
  RetrievalRequestError,
  RetrievalService,
  type QueryEmbedder,
  type SearchPort,
} from '../retrieval/retrievalService.js';
import { RETRIEVAL_MODES } from '../retrieval/searchQueryBuilder.js';
import { retrievalSettingsFromConfig } from '../retrieval/settings.js';

/** Injection points: tests supply a search client and file reader. */
export interface RetrievalCommandDependencies {
  readonly env: EnvironmentSource;
  readonly createSearch?: (settings: SearchClientSettings, logger: Logger) => Promise<SearchPort>;
  readonly createEmbedder?: (settings: EmbeddingSettings, logger: Logger) => Promise<QueryEmbedder>;
  /** Directory relative paths resolve against: pnpm's INIT_CWD (where the user ran pnpm). */
  readonly cwd?: string;
  readonly readTextFile?: (path: string, maxBytes: number) => Promise<string>;
}

const MAX_VECTOR_FILE_BYTES = 1024 * 1024;
/** Failures that would repeat for every case, so the evaluation stops at the first. */
const FATAL_SEARCH_CATEGORIES: ReadonlySet<string> = new Set([
  'authentication',
  'authorization',
  'not_found',
  'network',
  'dimension_mismatch',
]);

class InputFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputFileError';
  }
}

async function defaultReadTextFile(path: string, maxBytes: number): Promise<string> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new InputFileError('The path is not a file.');
    }
    size = info.size;
  } catch (error) {
    if (error instanceof InputFileError) {
      throw error;
    }
    throw new InputFileError('The file could not be read.');
  }
  if (size > maxBytes) {
    throw new InputFileError(`The file is larger than ${String(maxBytes)} bytes.`);
  }
  return readFile(path, 'utf8');
}

function resolveInputPath(dependencies: RetrievalCommandDependencies, path: string): string {
  return resolve(dependencies.cwd ?? dependencies.env['INIT_CWD'] ?? process.cwd(), path);
}

export interface RetrievalSetup {
  readonly service: RetrievalService;
  readonly tenantId: string;
}

/**
 * Validates configuration (names only on failure) and builds the retrieval service. The tenant
 * comes from AZURE_TENANT_ID, the tenant the indexer stamps on every chunk.
 */
export async function openRetrieval(
  dependencies: RetrievalCommandDependencies,
  logger: Logger,
  options: { readonly requireEmbeddings?: boolean } = {},
): Promise<RetrievalSetup> {
  const searchConfig = loadConfig(azureSearchConfigSchema, dependencies.env);
  const retrievalConfig = loadConfig(retrievalConfigSchema, dependencies.env);
  const tenantId = loadConfig(
    z.object({ AZURE_TENANT_ID: azureIdentityConfigShape.AZURE_TENANT_ID }),
    dependencies.env,
  ).AZURE_TENANT_ID;
  const createSearch =
    dependencies.createSearch ??
    ((settings: SearchClientSettings, log: Logger) =>
      createSearchIndexClient(settings, { logger: log }));
  const embedder = await openQueryEmbedder(
    dependencies,
    searchConfig.AZURE_SEARCH_VECTOR_DIMENSIONS,
    logger,
    options.requireEmbeddings === true,
  );
  const search = await createSearch(searchConfig, logger);
  return {
    service: new RetrievalService({
      search,
      settings: retrievalSettingsFromConfig(retrievalConfig),
      ...(embedder === undefined ? {} : { embedder }),
      logger,
    }),
    tenantId,
  };
}

/**
 * Query embeddings when an embedding deployment is configured (or required); keyword retrieval
 * otherwise. Partly configured settings are an error rather than a silent fallback, and the
 * embedding size must match the index.
 */
async function openQueryEmbedder(
  dependencies: RetrievalCommandDependencies,
  indexDimensions: number,
  logger: Logger,
  required: boolean,
): Promise<QueryEmbedder | undefined> {
  // The embedding deployment is the switch: AZURE_OPENAI_ENDPOINT and the key are shared with
  // the chat deployment, so their presence alone does not mean embeddings are wanted.
  const deployment = dependencies.env['AZURE_OPENAI_EMBEDDING_DEPLOYMENT']?.trim() ?? '';
  if (!required && deployment === '') {
    return undefined;
  }
  const settings = loadConfig(embeddingConfigSchema, dependencies.env);
  if (settings.AZURE_OPENAI_EMBEDDING_DIMENSIONS !== indexDimensions) {
    throw new EmbeddingError(
      `AZURE_OPENAI_EMBEDDING_DIMENSIONS (${String(settings.AZURE_OPENAI_EMBEDDING_DIMENSIONS)}) does not match AZURE_SEARCH_VECTOR_DIMENSIONS (${String(indexDimensions)}).`,
      { category: 'dimension_mismatch' },
    );
  }
  return (
    dependencies.createEmbedder ??
    ((resolved, log) => createEmbeddingProvider(resolved, { logger: log }))
  )(settings, logger);
}

export interface FailureReport {
  readonly status: 'error';
  readonly error: {
    readonly category: string;
    readonly message: string;
    readonly httpStatus?: number;
    readonly problems?: readonly string[];
  };
}

export function describeFailure(error: unknown): FailureReport | undefined {
  if (error instanceof ConfigValidationError) {
    return {
      status: 'error',
      error: {
        category: 'configuration',
        message: 'Configuration is missing or invalid.',
        problems: error.issues.map((issue) => `${issue.variable}: ${issue.message}`),
      },
    };
  }
  if (isSearchServiceError(error)) {
    return {
      status: 'error',
      error: {
        category: error.category,
        message: error.message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      },
    };
  }
  if (isEmbeddingError(error)) {
    return {
      status: 'error',
      error: {
        category: error.category,
        message: error.message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      },
    };
  }
  if (error instanceof SearchScopeError) {
    return { status: 'error', error: { category: error.code, message: error.message } };
  }
  if (error instanceof RetrievalRequestError || error instanceof InvalidFilterValueError) {
    return { status: 'error', error: { category: 'invalid_request', message: error.message } };
  }
  if (error instanceof EvaluationFileError) {
    return {
      status: 'error',
      error: { category: 'invalid_file', message: error.message, problems: error.problems },
    };
  }
  if (error instanceof InputFileError) {
    return { status: 'error', error: { category: 'invalid_file', message: error.message } };
  }
  return undefined;
}

function renderFailure(report: FailureReport, action: string): string {
  const lines = [
    `${action} failed: ${sanitizeText(report.error.category, 40)}`,
    `  ${sanitizeText(report.error.message, 400)}`,
  ];
  if (report.error.httpStatus !== undefined) {
    lines.push(`  HTTP status: ${String(report.error.httpStatus)}`);
  }
  for (const problem of report.error.problems ?? []) {
    lines.push(`  - ${sanitizeText(problem, 300)}`);
  }
  return redactString(lines.join('\n'));
}

export async function withErrorHandling(
  context: CommandContext,
  action: string,
  body: () => Promise<number>,
  describe: (error: unknown) => FailureReport | undefined = describeFailure,
): Promise<number> {
  const json = context.args.includes('--json');
  try {
    return await body();
  } catch (error) {
    if (error instanceof UsageError) {
      context.stdout(sanitizeText(error.message, 200));
      return EXIT_USAGE;
    }
    const report = describe(error);
    if (report === undefined) {
      throw error;
    }
    context.logger.warn(`${action} failed.`, {
      category: report.error.category,
      httpStatus: report.error.httpStatus,
    });
    context.stdout(
      json ? redactString(JSON.stringify(report, null, 2)) : renderFailure(report, action),
    );
    return EXIT_FAILURE;
  }
}

/** Accepts repeated flags and comma-separated lists: `--x a,b --x c`. */
export const commaList = z
  .array(z.string())
  .transform((values) => values.flatMap((value) => value.split(',')).map((value) => value.trim()));

const retrieveArgs = z
  .object({
    question: z.string(),
    'course-id': courseIdListSchema,
    'resource-type': commaList
      .pipe(z.array(z.enum(SEARCH_RESOURCE_TYPES)).min(1).max(SEARCH_RESOURCE_TYPES.length))
      .optional(),
    'top-k': z
      .string()
      .regex(/^\d{1,2}$/, { message: 'must be a whole number from 1 to 50.' })
      .transform(Number)
      .pipe(
        z
          .number()
          .min(1, { message: 'must be at least 1.' })
          .max(50, { message: 'must be at most 50.' }),
      )
      .optional(),
    mode: z.enum(RETRIEVAL_MODES).optional(),
    'vector-file': z.string().min(1).optional(),
    excerpts: z.boolean().optional(),
    json: z.boolean().optional(),
  })
  .strict();

const vectorFileSchema = z.array(z.number()).min(1).max(8192);

async function readVector(
  dependencies: RetrievalCommandDependencies,
  path: string,
): Promise<number[]> {
  const text = await (dependencies.readTextFile ?? defaultReadTextFile)(
    resolveInputPath(dependencies, path),
    MAX_VECTOR_FILE_BYTES,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InputFileError('The vector file is not valid JSON.');
  }
  const parsed = vectorFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InputFileError('The vector file must be a JSON array of numbers.');
  }
  return parsed.data;
}

export function createRetrieveCommand(
  dependencies: RetrievalCommandDependencies,
): CommandDefinition {
  return {
    description:
      'Retrieve chunks for a question --question <text> --course-id <id[,id]> [--resource-type <t[,t]>] [--top-k <n>] [--mode keyword|vector|hybrid --vector-file <path>] [--excerpts] [--json].',
    run: (context) =>
      withErrorHandling(context, 'Retrieval', async () => {
        const args = parseCommandArgs(
          context.args,
          {
            question: 'string',
            'course-id': 'string[]',
            'resource-type': 'string[]',
            'top-k': 'string',
            mode: 'string',
            'vector-file': 'string',
            excerpts: 'boolean',
            json: 'boolean',
          },
          retrieveArgs,
        );
        const queryVector =
          args['vector-file'] === undefined
            ? undefined
            : await readVector(dependencies, args['vector-file']);
        const { service, tenantId } = await openRetrieval(dependencies, context.logger);
        const result = await service.retrieve({
          question: args.question,
          tenantId,
          // Development command: the operator states the authorised courses. In the app they
          // come from the user's Moodle enrolments (phase 14).
          authorizedCourseIds: args['course-id'],
          ...(args['resource-type'] === undefined ? {} : { resourceTypes: args['resource-type'] }),
          ...(args['top-k'] === undefined ? {} : { topK: args['top-k'] }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
          ...(queryVector === undefined ? {} : { queryVector }),
        });
        const diagnostics = new RetrievalDiagnostics({ excerpts: args.excerpts === true });
        context.stdout(
          args.json === true ? diagnostics.renderJson(result) : diagnostics.renderText(result),
        );
        return EXIT_OK;
      }),
  };
}

const evaluationArgs = z
  .object({
    file: z.string().min(1),
    case: commaList.pipe(z.array(z.string().min(1).max(64)).min(1).max(2000)).optional(),
    excerpts: z.boolean().optional(),
    json: z.boolean().optional(),
  })
  .strict();

export function createRetrievalEvaluationCommand(
  dependencies: RetrievalCommandDependencies,
): CommandDefinition {
  return {
    description:
      'Run retrieval evaluation cases --file <path> [--case <id[,id]>] [--excerpts] [--json]. Exit 1 if any case fails.',
    run: (context) =>
      withErrorHandling(context, 'Retrieval evaluation', async () => {
        const args = parseCommandArgs(
          context.args,
          { file: 'string', case: 'string[]', excerpts: 'boolean', json: 'boolean' },
          evaluationArgs,
        );
        const text = await (dependencies.readTextFile ?? defaultReadTextFile)(
          resolveInputPath(dependencies, args.file),
          MAX_EVALUATION_FILE_BYTES,
        ).catch((error: unknown) => {
          throw error instanceof InputFileError
            ? error
            : new InputFileError('The file could not be read.');
        });
        let cases = parseEvaluationFile(text);
        if (args.case !== undefined) {
          const wanted = new Set(args.case);
          cases = cases.filter((testCase) => wanted.has(testCase.id));
          if (cases.length === 0) {
            throw new UsageError('--case: no case in the file has that ID.');
          }
        }
        const { service, tenantId } = await openRetrieval(dependencies, context.logger);
        const runner = new EvaluationRunner({
          retriever: service,
          tenantId,
          diagnostics: { excerpts: args.excerpts === true },
          describeError: (error) => describeFailure(error)?.error.message ?? 'Unexpected error.',
          isFatal: (error) =>
            (isSearchServiceError(error) || isEmbeddingError(error)) &&
            FATAL_SEARCH_CATEGORIES.has(error.category),
        });
        const report = await runner.run(cases);
        context.logger.info('Retrieval evaluation completed.', { ...report.summary });
        context.stdout(
          args.json === true ? renderEvaluationJson(report) : renderEvaluationText(report),
        );
        return report.summary.failed === 0 ? EXIT_OK : EXIT_FAILURE;
      }),
  };
}
