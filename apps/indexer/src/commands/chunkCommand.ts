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

const chunkArgs = z
  .object({
    json: z.boolean().optional(),
    preview: z.boolean().optional(),
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
export function createChunkTestCommand(dependencies: MoodleCommandDependencies): CommandDefinition {
  return {
    description:
      'Chunk one resource and show chunk numbers, token counts and metadata --course-id <id> --resource-id <id> [--preview] [--json].',
    run: (context) =>
      withMoodleErrorHandling(
        { context, action: 'Chunking test', json: context.args.includes('--json') },
        async () => {
          const args = parseCommandArgs(
            context.args,
            { json: 'boolean', preview: 'boolean', 'course-id': 'string', 'resource-id': 'string' },
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
            // Enrolment-based access lists arrive in phase 14; diagnostics never index anything.
            access: { allowedUserIds: [], allowedGroupIds: [] },
            indexedAt: new Date().toISOString(),
          });

          const notes = [
            ...(tenant.success
              ? []
              : [
                  `AZURE_TENANT_ID is not set; chunk IDs use the placeholder tenant "${DIAGNOSTIC_TENANT}".`,
                ]),
            'Access lists are empty until enrolment security (phase 14); empty lists deny everyone.',
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
          context.stdout(
            args.json === true ? renderJson(diagnostic) : renderChunkingText(diagnostic),
          );
          return chunks.length > 0 ? EXIT_OK : EXIT_FAILURE;
        },
      ),
  };
}
