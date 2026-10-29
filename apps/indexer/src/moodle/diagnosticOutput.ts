import { redactString, sanitizeText } from '@ehub/shared';

import type { CourseDiscoveryResult } from './discoverCourses.js';
import type {
  CourseModule,
  CourseStructure,
  CourseSummary,
  SupportStatus,
  UnsupportedReason,
} from './models.js';
import type { PingReport } from './pingMoodle.js';

/*
 * Rendering for the moodle:* diagnostic commands. Output contains metadata only: names,
 * IDs, types, sizes, timestamps and token-free URLs. Descriptions, summaries and file
 * content are never included. Names come from Moodle and are treated as untrusted text.
 */

export interface CourseDiagnosticSummary {
  readonly sections: number;
  readonly hiddenSections: number;
  readonly modules: number;
  readonly hiddenModules: number;
  readonly contentItems: number;
  readonly files: number;
  readonly downloadableFiles: number;
  readonly resources: number;
  readonly supportedResources: number;
  readonly unsupportedResources: number;
  readonly supportedModules: number;
  readonly unsupportedModules: number;
  readonly hiddenResources: number;
  readonly moduleTypes: Readonly<Record<string, number>>;
  readonly unsupportedReasons: Readonly<Partial<Record<UnsupportedReason, number>>>;
  readonly warnings: Readonly<Record<string, number>>;
}

function increment<K extends string>(record: Partial<Record<K, number>>, key: K): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** Copies a count record with keys in a stable order, so output is deterministic. */
function sortedRecord<R extends Partial<Record<string, number>>>(record: R): R {
  const sorted: Partial<Record<string, number>> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted as R;
}

export function summarizeCourseStructure(structure: CourseStructure): CourseDiagnosticSummary {
  const modules = structure.sections.flatMap((section) => section.modules);
  const items = modules.flatMap((module) => module.contentItems);
  const moduleTypes: Record<string, number> = {};
  const unsupportedReasons: Partial<Record<UnsupportedReason, number>> = {};
  const warnings: Record<string, number> = {};

  for (const module of modules) {
    increment(moduleTypes, module.moduleType);
    for (const warning of module.warnings) {
      increment(warnings, warning);
    }
    // Unsupported activity types produce no resources; count them once per module.
    if (
      module.support.status === 'unsupported' &&
      module.support.reason === 'module_type_not_supported'
    ) {
      increment(unsupportedReasons, 'module_type_not_supported');
    }
  }
  for (const resource of structure.resources) {
    if (resource.support.status === 'unsupported') {
      increment(unsupportedReasons, resource.support.reason);
    }
  }

  const supportedResources = structure.resources.filter(
    (r) => r.support.status === 'supported',
  ).length;
  const supportedModules = modules.filter((m) => m.support.status === 'supported').length;
  return {
    sections: structure.sections.length,
    hiddenSections: structure.sections.filter((section) => section.visible === false).length,
    modules: modules.length,
    hiddenModules: modules.filter((module) => module.visible === false).length,
    contentItems: items.length,
    files: items.filter((item) => item.kind === 'file').length,
    downloadableFiles: items.filter((item) => item.file !== undefined).length,
    resources: structure.resources.length,
    supportedResources,
    unsupportedResources: structure.resources.length - supportedResources,
    supportedModules,
    unsupportedModules: modules.length - supportedModules,
    hiddenResources: structure.resources.filter((resource) => resource.hiddenFromStudents).length,
    moduleTypes: sortedRecord(moduleTypes),
    unsupportedReasons: sortedRecord(unsupportedReasons),
    warnings: sortedRecord(warnings),
  };
}

// Moved to @ehub/shared in phase 7; re-exported for existing callers.
export { sanitizeText } from '@ehub/shared';

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return '-';
  }
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

function formatVisibility(visible: boolean | undefined): string {
  return visible === undefined ? 'visibility unknown' : visible ? 'visible' : 'hidden';
}

function formatSupport(support: SupportStatus): string {
  return support.status === 'supported' ? 'supported' : `unsupported (${support.reason})`;
}

/** Final pass over every rendered string: removes anything secret-shaped. */
export function finalizeOutput(text: string): string {
  return redactString(text);
}

export function renderJson(value: unknown): string {
  return finalizeOutput(JSON.stringify(value, null, 2));
}

export function renderPingText(report: PingReport): string {
  const lines = [
    `Moodle connection: ${report.status === 'ok' ? 'OK' : 'INCOMPLETE'}`,
    `  Site:             ${sanitizeText(report.site.name)} (${sanitizeText(report.site.url)})`,
    `  Release:          ${sanitizeText(report.site.release)}`,
    `  Service account:  ${sanitizeText(report.serviceAccount.username)} (user ${String(report.serviceAccount.userId)})`,
    `  File downloads:   ${report.downloadFilesEnabled === undefined ? 'unknown' : report.downloadFilesEnabled ? 'enabled' : 'DISABLED'}`,
    `  Functions:        ${String(report.functions.expected.length - report.functions.missing.length)} of ${String(report.functions.expected.length)} required functions available`,
  ];
  for (const name of report.functions.missing) {
    lines.push(`    missing:    ${sanitizeText(name)}`);
  }
  for (const name of report.functions.unexpected) {
    lines.push(
      `    unexpected: ${sanitizeText(name)} (not used by this application; remove from the service)`,
    );
  }
  if (report.warnings.includes('site_url_mismatch')) {
    lines.push('  Warning: Moodle reports a different site URL than MOODLE_BASE_URL.');
  }
  return finalizeOutput(lines.join('\n'));
}

export function renderCoursesText(result: CourseDiscoveryResult): string {
  if (result.courses.length === 0) {
    return finalizeOutput(
      `No matching courses (${String(result.returnedByMoodle)} returned by Moodle).`,
    );
  }
  const rows = result.courses.map((course: CourseSummary) => [
    String(course.id),
    sanitizeText(course.shortName, 30),
    course.visible === undefined ? '-' : course.visible ? 'yes' : 'no',
    sanitizeText(course.fullName, 70),
  ]);
  const header = ['ID', 'Short name', 'Visible', 'Full name'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const format = (row: readonly string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return finalizeOutput(
    [
      format(header),
      format(widths.map((width) => '-'.repeat(width))),
      ...rows.map(format),
      '',
      `${String(result.courses.length)} of ${String(result.returnedByMoodle)} courses shown${result.siteCourseExcluded ? ' (site front page excluded)' : ''}.`,
    ].join('\n'),
  );
}

function renderModule(module: CourseModule, lines: string[]): void {
  const flags = [
    module.visible === false ? 'hidden' : undefined,
    module.hasAvailabilityRestrictions ? 'restricted' : undefined,
  ].filter((flag) => flag !== undefined);
  lines.push(
    `  - [${String(module.id)}] ${sanitizeText(module.name)}  <${sanitizeText(module.moduleType, 30)} → ${module.kind}>  ${formatSupport(module.support)}${flags.length > 0 ? `  (${flags.join(', ')})` : ''}`,
  );
  if (module.bookChapters !== undefined && module.bookChapters.length > 0) {
    lines.push(`      chapters: ${String(module.bookChapters.length)}`);
  }
  for (const item of module.contentItems) {
    const chapter =
      item.bookChapterId === undefined ? '' : `  chapter ${String(item.bookChapterId)}`;
    lines.push(
      `      ${item.kind.padEnd(7)} ${sanitizeText(`${item.filePath}${item.fileName}`, 80)}  ${sanitizeText(item.mimeType, 60)}  ${formatBytes(item.sizeBytes)}  modified ${item.timeModified ?? '-'}  ${item.role}${chapter}  ${formatSupport(item.support)}`,
    );
  }
  for (const warning of module.warnings) {
    lines.push(`      warning: ${warning}`);
  }
}

export function renderInspectionText(
  structure: CourseStructure,
  summary: CourseDiagnosticSummary,
): string {
  const { course } = structure;
  const lines = [
    `Course ${String(course.id)}: ${sanitizeText(course.fullName)} (${sanitizeText(course.shortName, 40)}) — ${formatVisibility(course.visible)}`,
    `  ${sanitizeText(course.courseUrl, 200)}`,
    '',
    'Summary',
    `  Sections:   ${String(summary.sections)} (${String(summary.hiddenSections)} hidden)`,
    `  Modules:    ${String(summary.modules)} (${String(summary.hiddenModules)} hidden; ${String(summary.supportedModules)} supported, ${String(summary.unsupportedModules)} unsupported)`,
    `  Files:      ${String(summary.files)} (${String(summary.downloadableFiles)} downloadable)`,
    `  Resources:  ${String(summary.resources)} (${String(summary.supportedResources)} supported, ${String(summary.unsupportedResources)} unsupported, ${String(summary.hiddenResources)} hidden from students)`,
    `  Types:      ${
      Object.entries(summary.moduleTypes)
        .map(([type, count]) => `${sanitizeText(type, 30)}×${String(count)}`)
        .join(', ') || '-'
    }`,
  ];
  const reasons = Object.entries(summary.unsupportedReasons);
  if (reasons.length > 0) {
    lines.push(
      `  Unsupported: ${reasons.map(([reason, count]) => `${reason}×${String(count)}`).join(', ')}`,
    );
  }
  const warnings = Object.entries(summary.warnings);
  if (warnings.length > 0) {
    lines.push(
      `  Warnings:   ${warnings.map(([code, count]) => `${code}×${String(count)}`).join(', ')}`,
    );
  }

  for (const section of structure.sections) {
    lines.push(
      '',
      `[${section.sectionNumber === undefined ? '?' : String(section.sectionNumber)}] ${sanitizeText(section.name)}  (section ${String(section.id)}, ${formatVisibility(section.visible)}${section.hasAvailabilityRestrictions ? ', restricted' : ''})`,
    );
    if (section.modules.length === 0) {
      lines.push('  (no modules)');
    }
    for (const module of section.modules) {
      renderModule(module, lines);
    }
  }
  if (structure.sections.length === 0) {
    lines.push('', 'The course has no sections visible to the service account.');
  }
  return finalizeOutput(lines.join('\n'));
}
