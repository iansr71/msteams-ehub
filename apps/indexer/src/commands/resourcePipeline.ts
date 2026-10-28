import { extractionConfigSchema, loadConfig, type Logger } from '@ehub/shared';
import { z } from 'zod';

import {
  discoveryUnsupportedDiagnostic,
  toExtractionResource,
  type ExtractionDiagnostic,
} from '../extractors/extractionDiagnostics.js';
import { ExtractorRegistry, extractionLimitsFromConfig } from '../extractors/extractorRegistry.js';
import type { ExtractionResult } from '../extractors/types.js';
import { findCourseResource, inspectCourse } from '../moodle/inspectCourse.js';
import type { CourseResource, CourseStructure } from '../moodle/models.js';
import type { MoodleCommandDependencies } from './moodleServices.js';
import { openMoodleAccess } from './moodleServices.js';

export const resourceIdSchema = z
  .string()
  .min(1, { message: 'must not be empty.' })
  .max(1100, { message: 'is too long.' })
  .regex(/^\d+:(?:page|chapter:\d+|file:\/.*)$/, {
    message: 'must look like 501:file:/name.pdf, 601:page or 701:chapter:12 (see moodle:inspect).',
  });

export type ResourceExtraction =
  | {
      readonly kind: 'skipped';
      readonly structure: CourseStructure;
      readonly resource: CourseResource;
      readonly reason: string;
      readonly diagnostic: ExtractionDiagnostic;
    }
  | {
      readonly kind: 'extracted';
      readonly structure: CourseStructure;
      readonly resource: CourseResource;
      readonly result: ExtractionResult;
    };

/**
 * Shared by the diagnostic commands: locate one resource in a course, then download and extract
 * it. Resources that discovery already marked unsupported are not downloaded.
 */
export async function extractCourseResource(
  dependencies: MoodleCommandDependencies,
  logger: Logger,
  courseId: number,
  resourceId: string,
): Promise<ResourceExtraction> {
  const limits = extractionLimitsFromConfig(loadConfig(extractionConfigSchema, dependencies.env));
  const access = openMoodleAccess(dependencies, logger);
  const { structure } = await inspectCourse(access.client, access.baseUrl, courseId, {
    maxFileBytes: Math.min(access.settings.maxDownloadBytes, limits.maxInputBytes),
  });
  const resource = findCourseResource(structure, resourceId);
  const courseName = structure.course.fullName;

  if (resource.support.status === 'unsupported' || resource.sourceUrl === undefined) {
    const reason =
      resource.support.status === 'unsupported' ? resource.support.reason : 'missing_file_url';
    return {
      kind: 'skipped',
      structure,
      resource,
      reason,
      diagnostic: discoveryUnsupportedDiagnostic(resource, courseName, reason),
    };
  }

  const file = await access.downloader.download(resource.sourceUrl, {
    maxBytes: limits.maxInputBytes,
  });
  const registry = new ExtractorRegistry({ limits, logger });
  const result = await registry.extract(toExtractionResource(resource, courseName), {
    bytes: file.bytes,
    declaredContentType: file.contentType,
    lastModified: file.lastModified,
  });
  return { kind: 'extracted', structure, resource, result };
}
