import { EXIT_FAILURE, EXIT_OK, type CommandDefinition } from '@ehub/shared';
import { z } from 'zod';

import {
  renderExtractionText,
  toExtractionDiagnostic,
} from '../extractors/extractionDiagnostics.js';
import { renderJson } from '../moodle/diagnosticOutput.js';
import { courseIdSchema, parseCommandArgs } from './args.js';
import { withMoodleErrorHandling, type MoodleCommandDependencies } from './moodleServices.js';
import { extractCourseResource, resourceIdSchema } from './resourcePipeline.js';

const extractArgs = z
  .object({
    json: z.boolean().optional(),
    'no-preview': z.boolean().optional(),
    'course-id': courseIdSchema,
    'resource-id': resourceIdSchema,
  })
  .strict();

/**
 * Downloads and extracts one resource to check extraction end to end. Prints sanitized
 * metadata, counts and a short preview; the extracted document itself is never printed or
 * logged, and nothing is stored.
 */
export function createExtractTestCommand(
  dependencies: MoodleCommandDependencies,
): CommandDefinition {
  return {
    description:
      'Extract one resource and show metadata + short preview --course-id <id> --resource-id <id> [--no-preview] [--json].',
    run: (context) =>
      withMoodleErrorHandling(
        { context, action: 'Extraction test', json: context.args.includes('--json') },
        async () => {
          const args = parseCommandArgs(
            context.args,
            {
              json: 'boolean',
              'no-preview': 'boolean',
              'course-id': 'string',
              'resource-id': 'string',
            },
            extractArgs,
          );
          const outcome = await extractCourseResource(
            dependencies,
            context.logger,
            args['course-id'],
            args['resource-id'],
          );
          const { resource } = outcome;

          if (outcome.kind === 'skipped') {
            context.logger.info('Extraction test skipped: resource unsupported at discovery.', {
              courseId: resource.courseId,
              moduleId: resource.moduleId,
              reason: outcome.reason,
            });
            context.stdout(
              args.json === true
                ? renderJson(outcome.diagnostic)
                : renderExtractionText(outcome.diagnostic),
            );
            return EXIT_FAILURE;
          }

          const diagnostic = toExtractionDiagnostic(outcome.result, args['no-preview'] !== true);
          context.logger.info('Extraction test completed.', {
            courseId: resource.courseId,
            moduleId: resource.moduleId,
            status: outcome.result.status,
            reason: diagnostic.reason,
            blocks: diagnostic.statistics?.blocks,
            characters: diagnostic.statistics?.characters,
            warnings: diagnostic.warnings,
          });
          context.stdout(
            args.json === true ? renderJson(diagnostic) : renderExtractionText(diagnostic),
          );
          return outcome.result.status === 'extracted' ? EXIT_OK : EXIT_FAILURE;
        },
      ),
  };
}
