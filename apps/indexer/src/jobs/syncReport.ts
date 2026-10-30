import { redactString, sanitizeText } from '@ehub/shared';

import type { SyncCounts, SyncJobStatus, SyncJobType } from '../state/syncState.js';

export type ResourceAction =
  | 'indexed'
  | 'skipped'
  | 'excluded'
  | 'removed'
  | 'failed'
  | 'quarantined'
  | 'dead_letter'
  | 'would_index'
  | 'would_exclude'
  | 'would_remove';

/** IDs, statuses and categories only: never content or error messages. */
export interface ResourceReportEntry {
  readonly courseId: number;
  readonly resourceId: string;
  readonly action: ResourceAction;
  /** Change reasons, skip reason, exclusion or removal reason. */
  readonly reasons?: readonly string[];
  readonly failureCategory?: string;
  readonly chunks?: number;
  readonly staleChunksRemoved?: number;
  readonly chunksRemoved?: number;
  readonly retryCount?: number;
  /** Embeddings generated / served from cache. */
  readonly embeddings?: { readonly generated: number; readonly cached: number };
}

export type CourseOutcome =
  'synced' | 'locked' | 'not_found' | 'failed' | 'removed' | 'would_remove' | 'reconciled';

export interface CourseReportEntry {
  readonly courseId: number;
  readonly outcome: CourseOutcome;
  readonly failureCategory?: string;
  /** Removals the deletion guard blocked. */
  readonly deletionGuardBlocked?: number;
}

export interface SyncReport {
  readonly jobId: string;
  readonly jobType: SyncJobType;
  readonly dryRun: boolean;
  readonly status: SyncJobStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly counts: SyncCounts;
  readonly breakdown: Readonly<Record<ResourceAction, number>>;
  readonly courses: readonly CourseReportEntry[];
  readonly resources: readonly ResourceReportEntry[];
  readonly warnings: readonly string[];
  readonly failureCategory?: string;
}

const FAILED_ACTIONS: ReadonlySet<ResourceAction> = new Set([
  'failed',
  'quarantined',
  'dead_letter',
]);

export function countsOf(resources: readonly ResourceReportEntry[]): SyncCounts {
  const counts = { processed: 0, skipped: 0, updated: 0, removed: 0, failed: 0 };
  for (const entry of resources) {
    counts.processed += 1;
    if (FAILED_ACTIONS.has(entry.action)) {
      counts.failed += 1;
    } else if (entry.action === 'indexed' || entry.action === 'would_index') {
      counts.updated += 1;
    } else if (
      entry.action === 'removed' ||
      entry.action === 'would_remove' ||
      ((entry.action === 'excluded' || entry.action === 'would_exclude') &&
        (entry.chunksRemoved ?? 0) > 0)
    ) {
      counts.removed += 1;
    } else {
      counts.skipped += 1;
    }
  }
  return counts;
}

export class SyncReportBuilder {
  readonly #resources: ResourceReportEntry[] = [];
  readonly #courses: CourseReportEntry[] = [];
  readonly #warnings: string[] = [];

  constructor(
    readonly jobId: string,
    readonly jobType: SyncJobType,
    readonly dryRun: boolean,
    readonly startedAt: Date,
  ) {}

  addResource(entry: ResourceReportEntry): void {
    this.#resources.push(entry);
  }

  addCourse(entry: CourseReportEntry): void {
    this.#courses.push(entry);
  }

  warn(code: string): void {
    if (!this.#warnings.includes(code)) {
      this.#warnings.push(code);
    }
  }

  counts(): SyncCounts {
    return countsOf(this.#resources);
  }

  courseIds(): number[] {
    return [
      ...new Set([
        ...this.#courses.map((course) => course.courseId),
        ...this.#resources.map((entry) => entry.courseId),
      ]),
    ].sort((a, b) => a - b);
  }

  build(finishedAt: Date, failureCategory?: string): SyncReport {
    const counts = this.counts();
    const breakdown = Object.fromEntries(
      (
        [
          'indexed',
          'skipped',
          'excluded',
          'removed',
          'failed',
          'quarantined',
          'dead_letter',
          'would_index',
          'would_exclude',
          'would_remove',
        ] as const
      ).map((action) => [
        action,
        this.#resources.filter((entry) => entry.action === action).length,
      ]),
    ) as Record<ResourceAction, number>;
    const courseProblem = this.#courses.some(
      (course) =>
        course.outcome === 'locked' ||
        course.outcome === 'failed' ||
        course.outcome === 'not_found' ||
        (course.deletionGuardBlocked ?? 0) > 0,
    );
    const status: SyncJobStatus =
      failureCategory !== undefined
        ? 'failed'
        : counts.failed > 0 || courseProblem
          ? 'completed_with_failures'
          : 'succeeded';
    return {
      jobId: this.jobId,
      jobType: this.jobType,
      dryRun: this.dryRun,
      status,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      counts,
      breakdown,
      courses: [...this.#courses],
      resources: [...this.#resources],
      warnings: [...this.#warnings],
      ...(failureCategory === undefined ? {} : { failureCategory }),
    };
  }
}

const SHOWN_BY_DEFAULT: ReadonlySet<ResourceAction> = new Set([
  'indexed',
  'removed',
  'failed',
  'quarantined',
  'dead_letter',
  'would_index',
  'would_exclude',
  'would_remove',
]);

/** Sanitised text: counts, then courses, then changed or failed resources (all with `verbose`). */
export function renderSyncReportText(
  report: SyncReport,
  options: { verbose?: boolean } = {},
): string {
  const { counts } = report;
  const lines = [
    `Sync ${report.jobType}${report.dryRun ? ' (dry run: nothing was downloaded, indexed or stored)' : ''}: ${report.status}`,
    `  Job:        ${sanitizeText(report.jobId, 80)}`,
    `  Duration:   ${String(Math.round(report.durationMs / 100) / 10)} s`,
    `  Processed ${String(counts.processed)} | skipped ${String(counts.skipped)} | updated ${String(counts.updated)} | removed ${String(counts.removed)} | failed ${String(counts.failed)}`,
  ];
  const failedBreakdown = (['failed', 'quarantined', 'dead_letter'] as const)
    .filter((action) => report.breakdown[action] > 0)
    .map((action) => `${action} ${String(report.breakdown[action])}`);
  if (failedBreakdown.length > 0) {
    lines.push(`  Failures:   ${failedBreakdown.join(', ')}`);
  }
  if (report.failureCategory !== undefined) {
    lines.push(`  Stopped:    ${sanitizeText(report.failureCategory, 80)}`);
  }
  for (const warning of report.warnings) {
    lines.push(`  Warning:    ${sanitizeText(warning, 120)}`);
  }
  if (report.courses.length > 0) {
    lines.push('', 'Courses');
    for (const course of report.courses) {
      const details = [
        course.failureCategory === undefined
          ? ''
          : ` (${sanitizeText(course.failureCategory, 80)})`,
        (course.deletionGuardBlocked ?? 0) > 0
          ? ` — deletion guard kept ${String(course.deletionGuardBlocked)} resource(s); rerun with --allow-mass-delete after checking Moodle`
          : '',
      ].join('');
      lines.push(`  ${String(course.courseId).padStart(6)}  ${course.outcome}${details}`);
    }
  }
  const shown = report.resources.filter(
    (entry) => options.verbose === true || SHOWN_BY_DEFAULT.has(entry.action),
  );
  if (shown.length > 0) {
    lines.push('', 'Resources');
    for (const entry of shown) {
      const parts = [
        `  ${String(entry.courseId).padStart(6)}  ${entry.action.padEnd(13)} ${sanitizeText(entry.resourceId, 120)}`,
      ];
      if (entry.reasons !== undefined && entry.reasons.length > 0) {
        parts.push(`[${entry.reasons.map((reason) => sanitizeText(reason, 60)).join(', ')}]`);
      }
      if (entry.failureCategory !== undefined) {
        parts.push(`category=${entry.failureCategory}`);
      }
      if (entry.retryCount !== undefined && entry.retryCount > 0) {
        parts.push(`attempts=${String(entry.retryCount)}`);
      }
      if (entry.chunks !== undefined) {
        parts.push(`chunks=${String(entry.chunks)}`);
      }
      if ((entry.staleChunksRemoved ?? 0) > 0) {
        parts.push(`stale_removed=${String(entry.staleChunksRemoved)}`);
      }
      if ((entry.chunksRemoved ?? 0) > 0) {
        parts.push(`chunks_removed=${String(entry.chunksRemoved)}`);
      }
      lines.push(parts.join(' '));
    }
  }
  return redactString(lines.join('\n'));
}
