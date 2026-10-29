import {
  ConfigValidationError,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  parseCommandArgs,
  sanitizeText,
  type CommandContext,
  type CommandDefinition,
} from '@ehub/shared';
import { isEmbeddingError } from '@ehub/shared/embeddings';
import { z } from 'zod';

import { finalizeOutput, renderJson } from '../moodle/diagnosticOutput.js';
import {
  checkDimensionAlignment,
  openEmbeddingProvider,
  type EmbeddingCommandDependencies,
} from './embeddingServices.js';

const HINTS: Readonly<Record<string, string>> = {
  configuration: 'Set the listed variables in .env (local) or Key Vault / app settings (Azure).',
  authentication:
    'Locally, check AZURE_OPENAI_API_KEY. In Azure, check the Managed Identity, AZURE_OPENAI_TOKEN_SCOPE and the "Cognitive Services OpenAI User" role.',
  authorization:
    'Grant the identity the "Cognitive Services OpenAI User" role on the Azure OpenAI resource.',
  not_found: 'Check AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_EMBEDDING_DEPLOYMENT.',
  throttled:
    'The deployment is throttling requests. Lower EMBEDDING_REQUESTS_PER_MINUTE or raise the quota.',
  dimension_mismatch:
    'AZURE_OPENAI_EMBEDDING_DIMENSIONS must match the model and AZURE_SEARCH_VECTOR_DIMENSIONS.',
  input_too_long: 'Shorten the text; the model accepts at most EMBEDDING_MAX_INPUT_TOKENS tokens.',
  invalid_input: 'The text is empty after removing whitespace and control characters.',
};

interface FailureReport {
  readonly status: 'error';
  readonly error: {
    readonly category: string;
    readonly message: string;
    readonly httpStatus?: number;
    readonly problems?: readonly string[];
  };
  readonly hint?: string;
}

function describeFailure(error: unknown): FailureReport | undefined {
  if (error instanceof ConfigValidationError) {
    return {
      status: 'error',
      error: {
        category: 'configuration',
        message: 'Embedding configuration is missing or invalid.',
        problems: error.issues.map((issue) => `${issue.variable}: ${issue.message}`),
      },
      hint: HINTS['configuration'] ?? '',
    };
  }
  if (isEmbeddingError(error)) {
    const hint = HINTS[error.category];
    return {
      status: 'error',
      error: {
        category: error.category,
        message: error.message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      },
      ...(hint === undefined ? {} : { hint }),
    };
  }
  return undefined;
}

async function withErrorHandling(
  context: CommandContext,
  action: string,
  body: () => Promise<number>,
): Promise<number> {
  const json = context.args.includes('--json');
  try {
    return await body();
  } catch (error) {
    if (error instanceof UsageError) {
      context.stdout(sanitizeText(error.message, 200));
      return EXIT_USAGE;
    }
    const report = describeFailure(error);
    if (report === undefined) {
      throw error;
    }
    context.logger.warn(`${action} failed.`, {
      category: report.error.category,
      httpStatus: report.error.httpStatus,
    });
    const lines = [
      `${action} failed: ${report.error.category}`,
      `  ${sanitizeText(report.error.message, 400)}`,
      ...(report.error.problems ?? []).map((problem) => `  - ${sanitizeText(problem, 300)}`),
      ...(report.hint === undefined ? [] : [`  Hint: ${report.hint}`]),
    ];
    context.stdout(json ? renderJson(report) : finalizeOutput(lines.join('\n')));
    return EXIT_FAILURE;
  }
}

const healthArgs = z.object({ json: z.boolean().optional() }).strict();

export function createEmbeddingsHealthCommand(
  dependencies: EmbeddingCommandDependencies,
): CommandDefinition {
  return {
    description:
      'Check the embedding deployment and that its dimensions match the search index [--json].',
    run: (context) =>
      withErrorHandling(context, 'Embedding health check', async () => {
        const args = parseCommandArgs(context.args, { json: 'boolean' }, healthArgs);
        const { provider } = await openEmbeddingProvider(dependencies, context.logger);
        const health = await provider.healthCheck();
        const alignment = await checkDimensionAlignment(
          dependencies,
          provider.getDimensions(),
          context.logger,
        );
        const healthy = health.status === 'healthy' && alignment.aligned;
        const hint = health.failure === undefined ? undefined : HINTS[health.failure.category];
        context.logger.info('Embedding health check completed.', {
          status: health.status,
          aligned: alignment.aligned,
          latencyMs: health.latencyMs,
        });
        if (args.json === true) {
          context.stdout(
            renderJson({
              status: healthy ? 'healthy' : 'unhealthy',
              embedding: health,
              alignment,
              ...(hint === undefined ? {} : { hint }),
            }),
          );
        } else {
          const lines = [
            `Embeddings: ${healthy ? 'HEALTHY' : 'UNHEALTHY'}`,
            `  Authentication: ${health.authMode === 'api-key' ? 'API key' : 'Microsoft Entra ID'}`,
            `  Deployment: ${sanitizeText(health.deployment, 64)} (model ${sanitizeText(health.modelIdentifier, 64)}, version ${sanitizeText(health.embeddingVersion, 32)})`,
            `  Dimensions: expected ${String(health.expectedDimensions)}, returned ${health.returnedDimensions === undefined ? '-' : String(health.returnedDimensions)} (${String(health.latencyMs)} ms)`,
            `  Search index dimensions: configured ${alignment.configuredIndexDimensions === undefined ? '-' : String(alignment.configuredIndexDimensions)}, deployed ${alignment.deployedIndexDimensions === undefined ? '-' : String(alignment.deployedIndexDimensions)}`,
            ...[...health.problems, ...alignment.problems].map(
              (problem) => `  - ${sanitizeText(problem, 300)}`,
            ),
            ...(health.failure === undefined ? [] : [`  Failure: ${health.failure.category}`]),
            ...(hint === undefined ? [] : [`  Hint: ${hint}`]),
          ];
          context.stdout(finalizeOutput(lines.join('\n')));
        }
        return healthy ? EXIT_OK : EXIT_FAILURE;
      }),
  };
}

const testArgs = z
  .object({
    text: z.string(),
    'show-vector': z.boolean().optional(),
    json: z.boolean().optional(),
  })
  .strict();

const PREVIEW_VALUES = 5;

export function createEmbeddingsTestCommand(
  dependencies: EmbeddingCommandDependencies,
): CommandDefinition {
  return {
    description:
      'Embed one text and show model, dimensions and a short vector preview --text <text> [--show-vector] [--json].',
    run: (context) =>
      withErrorHandling(context, 'Embedding test', async () => {
        const args = parseCommandArgs(
          context.args,
          { text: 'string', 'show-vector': 'boolean', json: 'boolean' },
          testArgs,
        );
        const { provider } = await openEmbeddingProvider(dependencies, context.logger);
        const started = Date.now();
        const embedding = await provider.embedText(args.text);
        const norm = Math.sqrt(embedding.vector.reduce((sum, value) => sum + value * value, 0));
        const report = {
          ...embedding.metadata,
          cached: embedding.cached,
          textCharacters: args.text.length,
          durationMs: Date.now() - started,
          l2Norm: Math.round(norm * 1e6) / 1e6,
          // Only with --show-vector is the whole vector printed.
          ...(args['show-vector'] === true
            ? { vector: embedding.vector }
            : { vectorPreview: embedding.vector.slice(0, PREVIEW_VALUES) }),
        };
        context.logger.info('Embedding test completed.', {
          dimensions: embedding.metadata.dimensions,
          cached: embedding.cached,
          durationMs: report.durationMs,
        });
        if (args.json === true) {
          context.stdout(renderJson(report));
        } else {
          const lines = [
            `Embedding: ${String(report.dimensions)} dimensions from ${sanitizeText(report.modelIdentifier, 64)} (version ${sanitizeText(report.embeddingVersion, 32)})${report.cached ? ', from cache' : ''}`,
            `  Generated: ${report.generatedAt} | ${String(report.durationMs)} ms | L2 norm ${String(report.l2Norm)}`,
            `  Content hash: ${report.contentHash}`,
            `  Cache key: ${report.cacheKey}`,
            'vector' in report
              ? `  Vector: [${report.vector.join(', ')}]`
              : `  First ${String(PREVIEW_VALUES)} values: [${report.vectorPreview.map((value) => value.toFixed(6)).join(', ')}] (use --show-vector for all)`,
          ];
          context.stdout(finalizeOutput(lines.join('\n')));
        }
        return EXIT_OK;
      }),
  };
}

export function createEmbeddingCommands(
  dependencies: EmbeddingCommandDependencies,
): Readonly<Record<string, CommandDefinition>> {
  return {
    'embeddings:health': createEmbeddingsHealthCommand(dependencies),
    'embeddings:test': createEmbeddingsTestCommand(dependencies),
  };
}
