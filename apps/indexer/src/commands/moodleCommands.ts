import { EXIT_FAILURE, EXIT_OK, type CommandDefinition } from '@ehub/shared';
import { z } from 'zod';

import {
  renderCoursesText,
  renderInspectionText,
  renderJson,
  renderPingText,
} from '../moodle/diagnosticOutput.js';
import { discoverCourses } from '../moodle/discoverCourses.js';
import { inspectCourse } from '../moodle/inspectCourse.js';
import { pingMoodle } from '../moodle/pingMoodle.js';
import { courseIdListSchema, courseIdSchema, parseCommandArgs } from './args.js';
import {
  openMoodleAccess,
  withMoodleErrorHandling,
  type MoodleCommandDependencies,
} from './moodleServices.js';

const wantsJson = (args: readonly string[]): boolean => args.includes('--json');

const pingArgs = z.object({ json: z.boolean().optional() }).strict();

export function createMoodlePingCommand(
  dependencies: MoodleCommandDependencies,
): CommandDefinition {
  return {
    description: 'Check the Moodle connection and web-service setup [--json].',
    run: (context) =>
      withMoodleErrorHandling(
        { context, action: 'Moodle ping', json: wantsJson(context.args) },
        async () => {
          const args = parseCommandArgs(context.args, { json: 'boolean' }, pingArgs);
          const access = openMoodleAccess(dependencies, context.logger);
          const report = await pingMoodle(access.client, access.baseUrl);
          context.logger.info('Moodle ping completed.', {
            status: report.status,
            warnings: report.warnings,
            missingFunctions: report.functions.missing.length,
          });
          context.stdout(args.json === true ? renderJson(report) : renderPingText(report));
          return report.status === 'ok' ? EXIT_OK : EXIT_FAILURE;
        },
      ),
  };
}

const MAX_SEARCH_LENGTH = 200;

const coursesArgs = z
  .object({
    json: z.boolean().optional(),
    'course-id': courseIdListSchema.optional(),
    search: z
      .string()
      .trim()
      .min(1, { message: 'must not be empty.' })
      .max(MAX_SEARCH_LENGTH, {
        message: `must be at most ${String(MAX_SEARCH_LENGTH)} characters.`,
      })
      .optional(),
  })
  .strict();

export function createMoodleCoursesCommand(
  dependencies: MoodleCommandDependencies,
): CommandDefinition {
  return {
    description: 'List Moodle courses [--course-id <id[,id]>] [--search <text>] [--json].',
    run: (context) =>
      withMoodleErrorHandling(
        { context, action: 'Moodle course listing', json: wantsJson(context.args) },
        async () => {
          const args = parseCommandArgs(
            context.args,
            { json: 'boolean', 'course-id': 'string[]', search: 'string' },
            coursesArgs,
          );
          const access = openMoodleAccess(dependencies, context.logger);
          const result = await discoverCourses(access.client, access.baseUrl, {
            ...(args['course-id'] === undefined ? {} : { courseIds: args['course-id'] }),
            ...(args.search === undefined ? {} : { search: args.search }),
          });
          // Counts only: course names are content-adjacent and stay out of logs.
          context.logger.info('Moodle courses listed.', {
            returnedByMoodle: result.returnedByMoodle,
            shown: result.courses.length,
            filtered: args.search !== undefined || args['course-id'] !== undefined,
          });
          context.stdout(
            args.json === true
              ? renderJson({
                  courses: result.courses,
                  returnedByMoodle: result.returnedByMoodle,
                  siteCourseExcluded: result.siteCourseExcluded,
                })
              : renderCoursesText(result),
          );
          return EXIT_OK;
        },
      ),
  };
}

const inspectArgs = z
  .object({
    json: z.boolean().optional(),
    'course-id': courseIdSchema,
  })
  .strict();

export function createMoodleInspectCommand(
  dependencies: MoodleCommandDependencies,
): CommandDefinition {
  return {
    description: 'Show one course’s sections, modules and file metadata --course-id <id> [--json].',
    run: (context) =>
      withMoodleErrorHandling(
        { context, action: 'Moodle course inspection', json: wantsJson(context.args) },
        async () => {
          const args = parseCommandArgs(
            context.args,
            { json: 'boolean', 'course-id': 'string' },
            inspectArgs,
          );
          const access = openMoodleAccess(dependencies, context.logger);
          const { structure, summary } = await inspectCourse(
            access.client,
            access.baseUrl,
            args['course-id'],
            {
              maxFileBytes: access.settings.maxDownloadBytes,
            },
          );
          context.logger.info('Moodle course inspected.', {
            courseId: structure.course.id,
            sections: summary.sections,
            modules: summary.modules,
            files: summary.files,
            supportedResources: summary.supportedResources,
            unsupportedResources: summary.unsupportedResources,
          });
          context.stdout(
            args.json === true
              ? renderJson({
                  course: structure.course,
                  summary,
                  sections: structure.sections,
                  resources: structure.resources,
                })
              : renderInspectionText(structure, summary),
          );
          return EXIT_OK;
        },
      ),
  };
}

export function createMoodleCommands(
  dependencies: MoodleCommandDependencies,
): Readonly<Record<string, CommandDefinition>> {
  return {
    'moodle:ping': createMoodlePingCommand(dependencies),
    'moodle:courses': createMoodleCoursesCommand(dependencies),
    'moodle:inspect': createMoodleInspectCommand(dependencies),
  };
}
