import type {
  CreateOrUpdateIndexResult,
  IndexValidationResult,
  IndexingReport,
  SchemaDifference,
  SearchHealthReport,
} from '@ehub/shared/search';

import { finalizeOutput, sanitizeText } from '../moodle/diagnosticOutput.js';

/** What to do when the deployed index cannot be brought in line in place. */
export const MIGRATION_GUIDANCE = [
  'The deployed index cannot be changed in place. Do not delete it. Instead:',
  '  1. Set AZURE_SEARCH_INDEX_NAME to a new versioned name (e.g. ehub-course-content-v2).',
  '  2. Run search:create-index, then re-index all courses into the new index.',
  '  3. Validate it with search:validate-index and test queries.',
  '  4. Point the alias (or the answer service configuration) at the new index.',
  '  5. Remove the old index only after the new one has served traffic successfully.',
  'See docs/search-index.md.',
] as const;

const SEVERITY_LABEL: Readonly<Record<SchemaDifference['severity'], string>> = {
  incompatible: 'INCOMPATIBLE',
  compatible: 'compatible',
  informational: 'info',
};

function differenceLines(differences: readonly SchemaDifference[]): string[] {
  const order: readonly SchemaDifference['severity'][] = [
    'incompatible',
    'compatible',
    'informational',
  ];
  return order.flatMap((severity) =>
    differences
      .filter((difference) => difference.severity === severity)
      .map(
        (difference) => `  - [${SEVERITY_LABEL[severity]}] ${sanitizeText(difference.detail, 300)}`,
      ),
  );
}

const STATUS_TEXT: Readonly<Record<IndexValidationResult['status'], string>> = {
  missing: 'MISSING (run search:create-index)',
  match: 'OK (matches this version)',
  'compatible-changes':
    'NEEDS UPDATE (run search:create-index --apply-compatible-changes to update in place)',
  incompatible: 'INCOMPATIBLE (migration to a new index required)',
};

export function renderValidationText(result: IndexValidationResult): string {
  const lines = [
    `Index ${sanitizeText(result.indexName, 128)}: ${STATUS_TEXT[result.status]}`,
    `  Expected schema version: ${String(result.expectedSchemaVersion)}`,
    `  Deployed schema version: ${result.deployedSchemaVersion === undefined ? '-' : String(result.deployedSchemaVersion)}`,
  ];
  if (result.differences.length > 0) {
    lines.push('Differences:', ...differenceLines(result.differences));
  }
  if (result.status === 'incompatible') {
    lines.push('', ...MIGRATION_GUIDANCE);
  }
  return finalizeOutput(lines.join('\n'));
}

const OUTCOME_TEXT: Readonly<Record<CreateOrUpdateIndexResult['outcome'], string>> = {
  created: 'created',
  unchanged: 'already up to date; nothing changed',
  updated: 'updated in place',
  'changes-pending':
    'has compatible changes that were NOT applied (re-run with --apply-compatible-changes)',
  'migration-required': 'NOT changed: the schema needs a migration',
};

export function renderCreateIndexText(
  indexName: string,
  result: CreateOrUpdateIndexResult,
): string {
  const lines = [`Index ${sanitizeText(indexName, 128)} ${OUTCOME_TEXT[result.outcome]}.`];
  if (result.outcome !== 'created' && result.validation.differences.length > 0) {
    lines.push('Differences:', ...differenceLines(result.validation.differences));
  }
  if (result.outcome === 'migration-required') {
    lines.push('', ...MIGRATION_GUIDANCE);
  }
  return finalizeOutput(lines.join('\n'));
}

const formatBytes = (bytes: number | undefined): string =>
  bytes === undefined ? '-' : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function renderHealthText(report: SearchHealthReport, hint?: string): string {
  const lines = [
    `Azure AI Search: ${report.status.toUpperCase()}`,
    `  Authentication: ${report.authMode === 'api-key' ? 'API key' : 'Microsoft Entra ID'}`,
    `  Service reachable: ${report.serviceReachable ? 'yes' : 'no'} (${String(report.latencyMs)} ms)`,
    `  Index: ${sanitizeText(report.indexName, 128)} ${report.index === undefined ? '-' : report.index.exists ? 'exists' : 'MISSING'}`,
  ];
  if (report.schema !== undefined) {
    lines.push(`  Schema: ${report.schema}`);
  }
  if (report.index?.exists === true) {
    lines.push(
      `  Documents: ${String(report.index.documentCount ?? '-')}`,
      `  Storage: ${formatBytes(report.index.storageSizeBytes)} (vector index ${formatBytes(report.index.vectorIndexSizeBytes)})`,
    );
  }
  for (const [name, counter] of Object.entries(report.serviceCounters ?? {})) {
    lines.push(
      `  ${sanitizeText(name, 40)}: ${String(counter.usage)}${counter.quota === null ? '' : ` of ${String(counter.quota)}`}`,
    );
  }
  for (const problem of report.problems) {
    lines.push(`  - ${sanitizeText(problem, 300)}`);
  }
  if (report.failure !== undefined) {
    lines.push(`  Failure: ${report.failure.category}`);
  }
  if (hint !== undefined) {
    lines.push(`  Hint: ${hint}`);
  }
  return finalizeOutput(lines.join('\n'));
}

/** Indexing outcome for logs and command output: counts and keys only. */
export function summarizeIndexingReport(report: IndexingReport): Readonly<Record<string, unknown>> {
  const reasons: Record<string, number> = {};
  for (const failure of report.failed) {
    reasons[failure.reason] = (reasons[failure.reason] ?? 0) + 1;
  }
  return {
    action: report.action,
    attempted: report.attempted,
    succeeded: report.succeeded,
    failed: report.failed.length,
    failureReasons: reasons,
    requests: report.requests,
    retriedDocuments: report.retriedDocuments,
    durationMs: report.durationMs,
  };
}
