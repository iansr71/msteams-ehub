import {
  azureIdentityConfigShape,
  chunkingConfigSchema,
  EXIT_FAILURE,
  EXIT_OK,
  loadConfig,
  type CommandDefinition,
} from '@ehub/shared';
import { z } from 'zod';

import {
  renderExtractionText,
  toExtractionDiagnostic,
} from '../extractors/extractionDiagnostics.js';
import { renderJson } from '../moodle/diagnosticOutput.js';
import { StructuredChunker } from '../pipeline/chunkContent.js';
import { renderChunkingText, toChunkingDiagnostic } from '../pipeline/chunkDiagnostics.js';
import { chunkingSettingsFromConfig } from '../pipeline/chunkingSettings.js';
import { normalizeContent } from '../pipeline/normalizeContent.js';
import { courseIdSchema, parseCommandArgs } from './args.js';
import { withMoodleErrorHandling, type MoodleCommandDependencies } from './moodleServices.js';
import { extractCourseResource, resourceIdSchema } from './resourcePipeline.js';
import { embedChunks } from '../search/chunkEmbedder.js';
import {
  assertAligned,
  checkDimensionAlignment,
  openEmbeddingProvider,
  type EmbeddingCommandDependencies,
} from './embeddingServices.js';

interface EmbeddingSummary {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  readonly documents: number;
  readonly generated: number;
  readonly cached: number;
}

const chunkArgs = z
  .object({
    json: z.boolean().optional(),
    preview: z.boolean().optional(),
    embed: z.boolean().optional(),
    'course-id': courseIdSchema,
    'resource-id': resourceIdSchema,
  })
  .strict();

/** Placeholder tenant for diagnostics when AZURE_TENANT_ID is not configured. */
const DIAGNOSTIC_TENANT = 'local-diagnostic';

/**
 * Downloads, extracts and chunks one resource. Shows chunk numbers, token counts and source
 * metadata; chunk text is shown only as a 60-character preview, and only with --preview.
 * Nothing is indexed or stored.
 */
export function createChunkTestCommand(
  dependencies: MoodleCommandDependencies,
  embeddingDependencies: EmbeddingCommandDependencies = { env: dependencies.env },
): CommandDefinition {
  return {
    description:
      'Chunk one resource and show chunk numbers, token counts and metadata --course-id <id> --resource-id <id> [--preview] [--embed] [--json].',
    run: (context) =>
      withMoodleErrorHandling(
        { context, action: 'Chunking test', json: context.args.includes('--json') },
        async () => {
          const args = parseCommandArgs(
            context.args,
            {
              json: 'boolean',
              preview: 'boolean',
              embed: 'boolean',
              'course-id': 'string',
              'resource-id': 'string',
            },
            chunkArgs,
          );
          const chunkingConfig = loadConfig(chunkingConfigSchema, dependencies.env);
          const settings = chunkingSettingsFromConfig(chunkingConfig);
          const tenant = azureIdentityConfigShape.AZURE_TENANT_ID.safeParse(
            dependencies.env['AZURE_TENANT_ID'],
          );
          const tenantId = tenant.success ? tenant.data : DIAGNOSTIC_TENANT;

          const outcome = await extractCourseResource(
            dependencies,
            context.logger,
            args['course-id'],
            args['resource-id'],
          );
          if (outcome.kind === 'skipped') {
            context.stdout(
              args.json === true
                ? renderJson(outcome.diagnostic)
                : renderExtractionText(outcome.diagnostic),
            );
            return EXIT_FAILURE;
          }
          if (outcome.result.status !== 'extracted') {
            const diagnostic = toExtractionDiagnostic(outcome.result, false);
            context.stdout(
              args.json === true ? renderJson(diagnostic) : renderExtractionText(diagnostic),
            );
            return EXIT_FAILURE;
          }

          const document = normalizeContent(outcome.result);
          const categoryId = outcome.structure.course.categoryId;
          const courseCategory = categoryId === undefined ? undefined : String(categoryId);
          const chunks = new StructuredChunker(settings.options, settings.counter).chunk(document, {
            tenantId,
            courseCategory,
            // Access is enforced per course at query time; per-user lists stay empty.
            access: { allowedUserIds: [], allowedGroupIds: [] },
            indexedAt: new Date().toISOString(),
          });

          const notes = [
            ...(tenant.success
              ? []
              : [
                  `AZURE_TENANT_ID is not set; chunk IDs use the placeholder tenant "${DIAGNOSTIC_TENANT}".`,
                ]),
            'Access is enforced by authorised course at query time; per-user access lists are empty.',
          ];
          const diagnostic = toChunkingDiagnostic(
            document,
            chunks,
            { ...settings.options, tokenizer: settings.counter.encoding, tenantId },
            { courseCategory, includePreview: args.preview === true, notes },
          );
          context.logger.info('Chunking test completed.', {
            courseId: document.metadata.courseId,
            moduleId: document.metadata.moduleId,
            chunks: diagnostic.statistics.chunks,
            totalTokens: diagnostic.statistics.totalTokens,
            maxTokens: diagnostic.statistics.maxTokens,
          });
          // Optional: embed the chunks and build (but never upload) their index documents, to
          // check embeddings end to end. Vectors are summarised, never printed.
          let embedding: EmbeddingSummary | undefined;
          if (args.embed === true) {
            const { provider } = await openEmbeddingProvider(embeddingDependencies, context.logger);
            const alignment = await checkDimensionAlignment(
              embeddingDependencies,
              provider.getDimensions(),
              context.logger,
            );
            assertAligned(alignment);
            const embedded = await embedChunks(chunks, provider, provider.getDimensions());
            embedding = {
              model: provider.getModelIdentifier(),
              version: provider.getEmbeddingVersion(),
              dimensions: provider.getDimensions(),
              documents: embedded.documents.length,
              generated: embedded.generated,
              cached: embedded.cached,
            };
            context.logger.info('Chunk embedding test completed.', { ...embedding });
          }
          if (args.json === true) {
            context.stdout(
              renderJson(embedding === undefined ? diagnostic : { ...diagnostic, embedding }),
            );
          } else {
            context.stdout(
              embedding === undefined
                ? renderChunkingText(diagnostic)
                : `${renderChunkingText(diagnostic)}\nEmbeddings: ${String(embedding.documents)} documents built, ${String(embedding.generated)} generated, ${String(embedding.cached)} from cache (${embedding.model}, version ${embedding.version}, ${String(embedding.dimensions)} dimensions; nothing uploaded)`,
            );
          }
          return chunks.length > 0 ? EXIT_OK : EXIT_FAILURE;
        },
      ),
  };
}
