import {
  EXIT_FAILURE,
  EXIT_OK,
  extractionConfigSchema,
  loadConfig,
  type CommandDefinition,
} from '@ehub/shared';
import { z } from 'zod';

import {
  discoveryUnsupportedDiagnostic,
  renderExtractionText,
  toExtractionDiagnostic,
  toExtractionResource,
} from '../extractors/extractionDiagnostics.js';
import { ExtractorRegistry, extractionLimitsFromConfig } from '../extractors/extractorRegistry.js';
import { renderJson } from '../moodle/diagnosticOutput.js';
import { findCourseResource, inspectCourse } from '../moodle/inspectCourse.js';
import { courseIdSchema, parseCommandArgs } from './args.js';
import {
  openMoodleAccess,
  withMoodleErrorHandling,
  type MoodleCommandDependencies,
} from './moodleServices.js';

const extractArgs = z
  .object({
    json: z.boolean().optional(),
    'no-preview': z.boolean().optional(),
    'course-id': courseIdSchema,
    'resource-id': z
      .string()
      .min(1, { message: 'must not be empty.' })
      .max(1100, { message: 'is too long.' })
      .regex(/^\d+:(?:page|chapter:\d+|file:\/.*)$/, {
        message:
          'must look like 501:file:/name.pdf, 601:page or 701:chapter:12 (see moodle:inspect).',
      }),
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
          const limits = extractionLimitsFromConfig(
            loadConfig(extractionConfigSchema, dependencies.env),
          );
          const access = openMoodleAccess(dependencies, context.logger);
          const { structure } = await inspectCourse(
            access.client,
            access.baseUrl,
            args['course-id'],
            {
              maxFileBytes: Math.min(access.settings.maxDownloadBytes, limits.maxInputBytes),
            },
          );
          const resource = findCourseResource(structure, args['resource-id']);
          const courseName = structure.course.fullName;

          if (resource.support.status === 'unsupported' || resource.sourceUrl === undefined) {
            const reason =
              resource.support.status === 'unsupported'
                ? resource.support.reason
                : 'missing_file_url';
            const diagnostic = discoveryUnsupportedDiagnostic(resource, courseName, reason);
            context.logger.info('Extraction test skipped: resource unsupported at discovery.', {
              courseId: resource.courseId,
              moduleId: resource.moduleId,
              reason,
            });
            context.stdout(
              args.json === true ? renderJson(diagnostic) : renderExtractionText(diagnostic),
            );
            return EXIT_FAILURE;
          }

          const file = await access.downloader.download(resource.sourceUrl, {
            maxBytes: limits.maxInputBytes,
          });
          const registry = new ExtractorRegistry({ limits, logger: context.logger });
          const result = await registry.extract(toExtractionResource(resource, courseName), {
            bytes: file.bytes,
            declaredContentType: file.contentType,
            lastModified: file.lastModified,
          });
          const diagnostic = toExtractionDiagnostic(result, args['no-preview'] !== true);

          context.logger.info('Extraction test completed.', {
            courseId: resource.courseId,
            moduleId: resource.moduleId,
            status: result.status,
            reason: diagnostic.reason,
            blocks: diagnostic.statistics?.blocks,
            characters: diagnostic.statistics?.characters,
            warnings: diagnostic.warnings,
          });
          context.stdout(
            args.json === true ? renderJson(diagnostic) : renderExtractionText(diagnostic),
          );
          return result.status === 'extracted' ? EXIT_OK : EXIT_FAILURE;
        },
      ),
  };
}
