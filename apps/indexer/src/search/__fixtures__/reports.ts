import type {
  IndexValidationResult,
  IndexingReport,
  SearchHealthReport,
} from '@ehub/shared/search';

export const searchDiagnosticsFixture: {
  readonly validation: IndexValidationResult;
  readonly health: SearchHealthReport;
  readonly indexing: IndexingReport;
} = {
  validation: {
    indexName: 'ehub-course-content-v1',
    status: 'incompatible',
    expectedSchemaVersion: 1,
    deployedSchemaVersion: 1,
    differences: [
      {
        severity: 'compatible',
        kind: 'description',
        detail: 'Index description (which records the schema version) differs.',
      },
      {
        severity: 'incompatible',
        kind: 'field-attribute',
        field: 'courseName',
        attribute: 'filterable',
        expected: 'true',
        actual: 'false',
        detail: 'Field courseName: filterable is false, expected true.\u001b[31m',
      },
    ],
  },
  health: {
    status: 'healthy',
    authMode: 'entra-id',
    indexName: 'ehub-course-content-v1',
    serviceReachable: true,
    latencyMs: 12,
    serviceCounters: { documentCount: { usage: 10, quota: 1_000_000 } },
    index: {
      exists: true,
      documentCount: 10,
      storageSizeBytes: 2_097_152,
      vectorIndexSizeBytes: 1024,
    },
    schema: 'match',
    problems: [],
  },
  indexing: {
    action: 'upload',
    attempted: 3,
    succeeded: 1,
    failed: [
      { key: 'a', reason: 'rejected', statusCode: 400, message: undefined },
      { key: 'b', reason: 'retries-exhausted', statusCode: 503, message: undefined },
    ],
    requests: 2,
    retriedDocuments: 1,
    durationMs: 5,
  },
};
