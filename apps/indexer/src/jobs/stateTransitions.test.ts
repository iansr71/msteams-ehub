import {
  MoodleApiError,
  MoodleAuthenticationError,
  MoodleAuthorizationError,
  MoodleRateLimitError,
  MoodleTransportError,
  MoodleValidationError,
} from '@ehub/moodle-client';
import { EmbeddingError } from '@ehub/shared/embeddings';
import { SearchServiceError } from '@ehub/shared/search';
import { describe, expect, it } from 'vitest';

import { InvalidSearchDocumentError, VectorDimensionError } from '../search/searchDocuments.js';
import { resourceStateSchema, type ResourceState } from '../state/syncState.js';
import { SyncStateConflictError } from '../state/syncStateRepository.js';
import {
  COURSE,
  CONTENT_HASH,
  FILE_HASH,
  TENANT_ID,
  VERSIONS,
  indexedFingerprint,
  indexedState,
  makeResource,
} from './__fixtures__/resources.js';
import {
  decideResource,
  startsFreshAttempt,
  unchangedAfterHash,
  type DecisionInput,
} from './changeDetection.js';
import { classifyError, classifyExtractionFailure } from './failureClassification.js';
import { buildPipelineVersions, chunkerVersionLabel, sourceFingerprint } from './fingerprints.js';
import {
  InvalidTransitionError,
  retryDelayMs,
  transition,
  type ResourceEvent,
  type TransitionContext,
} from './stateTransitions.js';

const NOW = new Date('2026-02-10T08:00:00.000Z');

function decide(overrides: Partial<DecisionInput> = {}): ReturnType<typeof decideResource> {
  const resource = overrides.resource ?? makeResource();
  return decideResource({
    resource,
    courseHidden: false,
    source: sourceFingerprint(resource, COURSE),
    state: indexedState(),
    versions: VERSIONS,
    mode: 'incremental',
    force: false,
    includeHidden: false,
    includeDeadLetter: false,
    now: NOW,
    ...overrides,
  });
}

describe('change detection', () => {
  it('processes a resource with no state as new', () => {
    expect(decide({ state: undefined })).toEqual({ kind: 'process', reasons: ['new'] });
  });

  it('skips an indexed resource when nothing changed', () => {
    expect(decide()).toEqual({ kind: 'skip', reason: 'unchanged' });
  });

  it.each([
    ['Moodle modification time', { timeModified: '2026-02-05T09:00:00.000Z' }, ['moodle_modified']],
    ['file size', { sizeBytes: 6000 }, ['moodle_modified']],
    [
      'citation metadata (renamed section)',
      { sectionName: 'Aftercare (2026)' },
      ['metadata_changed'],
    ],
    [
      'file URL (new revision)',
      {
        sourceUrl:
          'https://ehub.example.test/webservice/pluginfile.php/5702/mod_resource/content/2/Aftercare.pdf',
      },
      ['metadata_changed'],
    ],
  ] as const)('reprocesses when the %s changes', (_label, change, reasons) => {
    const resource = makeResource(change);
    expect(decide({ resource })).toEqual({ kind: 'process', reasons });
  });

  it('reprocesses when the extractor, chunker or embedding version changes', () => {
    const versions = (overrides: Partial<Parameters<typeof buildPipelineVersions>[0]>) =>
      buildPipelineVersions({
        extractors: [
          { name: 'pdf', version: '1.0.0' },
          { name: 'html', version: '1.0.0' },
        ],
        chunker: VERSIONS.chunker,
        embeddingModel: VERSIONS.embeddingModel,
        embeddingVersion: VERSIONS.embeddingVersion,
        embeddingDimensions: VERSIONS.embeddingDimensions,
        ...overrides,
      });
    expect(
      decide({ versions: versions({ extractors: [{ name: 'pdf', version: '1.1.0' }] }) }),
    ).toEqual({
      kind: 'process',
      reasons: ['extractor_changed'],
    });
    // A change to a different extractor does not reprocess PDFs.
    expect(
      decide({
        versions: versions({
          extractors: [
            { name: 'pdf', version: '1.0.0' },
            { name: 'html', version: '2.0.0' },
          ],
        }),
      }),
    ).toEqual({ kind: 'skip', reason: 'unchanged' });
    expect(decide({ versions: versions({ chunker: 'structure-aware@1.0.0#def' }) })).toEqual({
      kind: 'process',
      reasons: ['chunker_changed'],
    });
    for (const change of [
      { embeddingModel: 'text-embedding-3-large' },
      { embeddingVersion: '2' },
      { embeddingDimensions: 16 },
    ]) {
      expect(decide({ versions: versions(change) })).toEqual({
        kind: 'process',
        reasons: ['embedding_changed'],
      });
    }
  });

  it('downloads to compare when Moodle reports no modification time', () => {
    const resource = makeResource({ timeModified: undefined });
    expect(decide({ resource, state: indexedState(resource) })).toEqual({
      kind: 'process',
      reasons: ['modified_unknown'],
    });
  });

  it('verifies unchanged resources in full mode', () => {
    expect(decide({ mode: 'full' })).toEqual({ kind: 'process', reasons: ['verify'] });
  });

  it('processes everything when forced, but never hidden or unsupported resources', () => {
    expect(decide({ force: true })).toEqual({ kind: 'process', reasons: ['forced'] });
    expect(decide({ force: true, resource: makeResource({ hiddenFromStudents: true }) })).toEqual({
      kind: 'exclude',
      reason: 'hidden',
    });
  });

  it('excludes hidden content unless hidden content is included', () => {
    expect(decide({ resource: makeResource({ hiddenFromStudents: true }) })).toEqual({
      kind: 'exclude',
      reason: 'hidden',
    });
    expect(decide({ courseHidden: true })).toEqual({ kind: 'exclude', reason: 'hidden' });
    expect(decide({ courseHidden: true, includeHidden: true })).toEqual({
      kind: 'skip',
      reason: 'unchanged',
    });
  });

  it('excludes resources discovery marked unsupported', () => {
    const resource = makeResource({
      support: { status: 'unsupported', reason: 'file_type_not_supported' },
    });
    expect(decide({ resource, state: undefined })).toEqual({
      kind: 'exclude',
      reason: 'unsupported:file_type_not_supported',
    });
    expect(decide({ resource: makeResource({ sourceUrl: undefined }), state: undefined })).toEqual({
      kind: 'exclude',
      reason: 'unsupported:missing_file_url',
    });
  });

  it('does not repeat an exclusion already recorded', () => {
    const state = indexedState(makeResource(), {
      status: 'excluded',
      statusReason: 'hidden',
      indexed: undefined,
    });
    expect(decide({ resource: makeResource({ hiddenFromStudents: true }), state })).toEqual({
      kind: 'skip',
      reason: 'already_excluded',
    });
    // Unhidden again: indexed as new.
    expect(decide({ state })).toEqual({ kind: 'process', reasons: ['new'] });
  });

  it('indexes a removed resource that reappears', () => {
    const state = indexedState(makeResource(), {
      status: 'removed',
      statusReason: 'deleted',
      indexed: undefined,
    });
    expect(decide({ state })).toEqual({ kind: 'process', reasons: ['new'] });
  });

  describe('failed resources', () => {
    const failed = (nextRetryAt: string): ResourceState =>
      indexedState(makeResource(), {
        status: 'failed',
        retryCount: 2,
        failureCategory: 'moodle_unavailable',
        nextRetryAt,
      });

    it('waits for the backoff in incremental and full mode', () => {
      expect(decide({ state: failed('2026-02-10T09:00:00.000Z') })).toEqual({
        kind: 'skip',
        reason: 'retry_not_due',
      });
      expect(decide({ state: failed('2026-02-10T09:00:00.000Z'), mode: 'full' })).toEqual({
        kind: 'skip',
        reason: 'retry_not_due',
      });
      expect(decide({ state: failed('2026-02-10T07:59:59.000Z') })).toEqual({
        kind: 'process',
        reasons: ['retry'],
      });
    });

    it('retries immediately in retry and single mode', () => {
      for (const mode of ['retry', 'single'] as const) {
        expect(decide({ state: failed('2026-02-11T00:00:00.000Z'), mode })).toEqual({
          kind: 'process',
          reasons: ['retry'],
        });
      }
    });

    it('retries at once when Moodle changes the resource', () => {
      expect(
        decide({
          state: failed('2026-02-11T00:00:00.000Z'),
          resource: makeResource({ timeModified: '2026-02-09T00:00:00.000Z' }),
        }),
      ).toEqual({ kind: 'process', reasons: ['moodle_modified'] });
    });

    it('carries version changes along with the retry', () => {
      const versions = { ...VERSIONS, embeddingVersion: '2' };
      expect(
        decide({
          state: failed('2026-02-11T00:00:00.000Z'),
          resource: makeResource({ timeModified: '2026-02-09T00:00:00.000Z' }),
          versions,
        }),
      ).toEqual({ kind: 'process', reasons: ['moodle_modified', 'embedding_changed'] });
    });
  });

  describe('quarantined and dead-lettered resources', () => {
    const quarantined = indexedState(makeResource(), {
      status: 'quarantined',
      failureCategory: 'encrypted',
      indexed: undefined,
      extractorSetVersion: VERSIONS.extractorSet,
    });
    const deadLetter = indexedState(makeResource(), {
      status: 'dead_letter',
      retryCount: 5,
      failureCategory: 'moodle_unavailable',
    });

    it('stays quarantined until the source or an extractor changes', () => {
      for (const mode of ['incremental', 'full', 'retry', 'single'] as const) {
        expect(decide({ state: quarantined, mode })).toEqual({
          kind: 'skip',
          reason: 'quarantined',
        });
      }
      expect(decide({ state: quarantined, resource: makeResource({ sizeBytes: 9000 }) })).toEqual({
        kind: 'process',
        reasons: ['moodle_modified'],
      });
      expect(
        decide({ state: quarantined, versions: { ...VERSIONS, extractorSet: 'set#other' } }),
      ).toEqual({ kind: 'process', reasons: ['extractor_changed'] });
    });

    it('retries a dead-lettered resource only on change or an explicit operator retry', () => {
      expect(decide({ state: deadLetter })).toEqual({ kind: 'skip', reason: 'dead_letter' });
      expect(decide({ state: deadLetter, mode: 'retry' })).toEqual({
        kind: 'skip',
        reason: 'dead_letter',
      });
      expect(decide({ state: deadLetter, mode: 'retry', includeDeadLetter: true })).toEqual({
        kind: 'process',
        reasons: ['operator_retry'],
      });
      expect(
        decide({
          state: deadLetter,
          resource: makeResource({ timeModified: '2026-03-01T00:00:00.000Z' }),
        }),
      ).toEqual({ kind: 'process', reasons: ['moodle_modified'] });
    });
  });

  describe('after download', () => {
    const state = indexedState();

    it('treats a matching file or content hash as unchanged when only the source may have changed', () => {
      expect(unchangedAfterHash(['moodle_modified'], state, { fileHash: FILE_HASH })).toBe(true);
      expect(
        unchangedAfterHash(['verify'], state, {
          fileHash: '9'.repeat(64),
          contentHash: CONTENT_HASH,
        }),
      ).toBe(true);
      expect(unchangedAfterHash(['modified_unknown'], state, { fileHash: '9'.repeat(64) })).toBe(
        false,
      );
    });

    it('never skips when a version or metadata changed, or nothing is indexed', () => {
      for (const reason of [
        'metadata_changed',
        'extractor_changed',
        'chunker_changed',
        'embedding_changed',
        'retry',
        'forced',
        'new',
      ] as const) {
        expect(
          unchangedAfterHash(['moodle_modified', reason], state, { fileHash: FILE_HASH }),
        ).toBe(false);
      }
      expect(
        unchangedAfterHash(
          ['moodle_modified'],
          { ...state, indexed: undefined },
          { fileHash: FILE_HASH },
        ),
      ).toBe(false);
      expect(unchangedAfterHash(['moodle_modified'], undefined, { fileHash: FILE_HASH })).toBe(
        false,
      );
    });

    it('starts a fresh retry budget only when the source changed or an operator asked', () => {
      expect(startsFreshAttempt(['retry'])).toBe(false);
      expect(startsFreshAttempt(['chunker_changed'])).toBe(false);
      expect(startsFreshAttempt(['moodle_modified'])).toBe(true);
      expect(startsFreshAttempt(['operator_retry'])).toBe(true);
    });
  });

  it('versions chunking by settings as well as algorithm', () => {
    const base = { targetTokens: 850, maxTokens: 1000, minTokens: 100, overlapTokens: 125 };
    expect(chunkerVersionLabel(base, 'cl100k_base')).toBe(
      chunkerVersionLabel({ ...base }, 'cl100k_base'),
    );
    expect(chunkerVersionLabel(base, 'cl100k_base')).not.toBe(
      chunkerVersionLabel({ ...base, targetTokens: 600 }, 'cl100k_base'),
    );
    expect(chunkerVersionLabel(base, 'cl100k_base')).not.toBe(
      chunkerVersionLabel(base, 'o200k_base'),
    );
  });
});

const context: TransitionContext = {
  tenantId: TENANT_ID,
  courseId: 12,
  resourceId: '702:file:/Aftercare.pdf',
  moduleId: 702,
  jobId: 'job-7',
  jobType: 'incremental',
  now: NOW,
  maxAttempts: 3,
  retryBaseDelayMs: 600_000,
  retryMaxDelayMs: 3_600_000,
};
const source = sourceFingerprint(makeResource(), COURSE);
const newIndexed = indexedFingerprint(makeResource(), {
  fileHash: '3'.repeat(64),
  contentHash: '4'.repeat(64),
  indexedAt: NOW.toISOString(),
});

function apply(previous: ResourceState | undefined, ...events: ResourceEvent[]): ResourceState {
  let state = previous;
  for (const event of events) {
    state = resourceStateSchema.parse(transition(state, event, context));
  }
  if (state === undefined) {
    throw new Error('no events');
  }
  return state;
}

const transientFailure = (freshAttempt = false): ResourceEvent => ({
  kind: 'transient_failure',
  source,
  category: 'moodle_unavailable',
  freshAttempt,
});

describe('state transitions', () => {
  it('new → indexed records the fingerprint and success time', () => {
    const state = apply(undefined, { kind: 'indexed', source, indexed: newIndexed });
    expect(state).toMatchObject({
      status: 'indexed',
      retryCount: 0,
      indexed: newIndexed,
      lastSuccessfulIndexAt: NOW.toISOString(),
      lastAttemptAt: NOW.toISOString(),
      lastJobId: 'job-7',
      lastJobType: 'incremental',
      lastFileHash: '3'.repeat(64),
      lastContentHash: '4'.repeat(64),
    });
    expect(state.failureCategory).toBeUndefined();
  });

  it('transient failures back off exponentially, keep indexed chunks, then dead-letter', () => {
    const first = apply(indexedState(), transientFailure());
    expect(first).toMatchObject({
      status: 'failed',
      retryCount: 1,
      failureCategory: 'moodle_unavailable',
      nextRetryAt: '2026-02-10T08:10:00.000Z',
      indexed: indexedFingerprint(),
      lastSuccessfulIndexAt: '2026-02-01T11:00:00.000Z',
    });
    const second = apply(first, transientFailure());
    expect(second).toMatchObject({
      status: 'failed',
      retryCount: 2,
      nextRetryAt: '2026-02-10T08:20:00.000Z',
    });
    const third = apply(second, transientFailure());
    expect(third).toMatchObject({
      status: 'dead_letter',
      retryCount: 3,
      indexed: indexedFingerprint(),
    });
    expect(third.nextRetryAt).toBeUndefined();
  });

  it('a source change starts a fresh retry budget', () => {
    const failed = apply(indexedState(), transientFailure(), transientFailure());
    expect(apply(failed, transientFailure(true))).toMatchObject({
      status: 'failed',
      retryCount: 1,
    });
  });

  it('failed → indexed clears the failure', () => {
    const recovered = apply(indexedState(), transientFailure(), {
      kind: 'indexed',
      source,
      indexed: newIndexed,
    });
    expect(recovered).toMatchObject({ status: 'indexed', retryCount: 0, indexed: newIndexed });
    expect(recovered.failureCategory).toBeUndefined();
    expect(recovered.nextRetryAt).toBeUndefined();
  });

  it('dead letter → indexed after an operator retry succeeds', () => {
    const dead = apply(indexedState(), transientFailure(), transientFailure(), transientFailure());
    expect(apply(dead, { kind: 'indexed', source, indexed: newIndexed }).status).toBe('indexed');
  });

  it('a permanent failure quarantines and keeps chunks unless they were removed', () => {
    const kept = apply(indexedState(), {
      kind: 'permanent_failure',
      source,
      category: 'encrypted',
      extractorSetVersion: VERSIONS.extractorSet,
      chunksRemoved: false,
      fileHash: '5'.repeat(64),
    });
    expect(kept).toMatchObject({
      status: 'quarantined',
      failureCategory: 'encrypted',
      extractorSetVersion: VERSIONS.extractorSet,
      indexed: indexedFingerprint(),
      lastFileHash: '5'.repeat(64),
      retryCount: 0,
    });
    const removed = apply(indexedState(), {
      kind: 'permanent_failure',
      source,
      category: 'encrypted',
      extractorSetVersion: VERSIONS.extractorSet,
      chunksRemoved: true,
    });
    expect(removed.indexed).toBeUndefined();
    expect(removed.lastFileHash).toBe(FILE_HASH);
  });

  it('content unchanged updates what was observed without re-indexing', () => {
    const changed = sourceFingerprint(
      makeResource({ timeModified: '2026-02-09T00:00:00.000Z' }),
      COURSE,
    );
    const state = apply(indexedState(), transientFailure(), {
      kind: 'content_unchanged',
      source: changed,
      fileHash: '6'.repeat(64),
      contentHash: CONTENT_HASH,
    });
    expect(state).toMatchObject({
      status: 'indexed',
      retryCount: 0,
      observed: changed,
      indexed: {
        moodleModifiedAt: '2026-02-09T00:00:00.000Z',
        fileHash: '6'.repeat(64),
        contentHash: CONTENT_HASH,
        indexedAt: '2026-02-01T11:00:00.000Z',
      },
      lastSuccessfulIndexAt: '2026-02-01T11:00:00.000Z',
    });
    // The next incremental run sees nothing to do.
    expect(
      decideResource({
        resource: makeResource({ timeModified: '2026-02-09T00:00:00.000Z' }),
        courseHidden: false,
        source: changed,
        state,
        versions: VERSIONS,
        mode: 'incremental',
        force: false,
        includeHidden: false,
        includeDeadLetter: false,
        now: NOW,
      }),
    ).toEqual({ kind: 'skip', reason: 'unchanged' });
  });

  it('content unchanged drops a size that Moodle stopped reporting', () => {
    const noSize = sourceFingerprint(makeResource({ sizeBytes: undefined }), COURSE);
    const state = apply(indexedState(), {
      kind: 'content_unchanged',
      source: noSize,
      fileHash: FILE_HASH,
    });
    expect(state.indexed?.moodleSizeBytes).toBeUndefined();
  });

  it('excluded and removed clear the indexed fingerprint', () => {
    const excluded = apply(indexedState(), { kind: 'excluded', source, reason: 'hidden' });
    expect(excluded).toMatchObject({ status: 'excluded', statusReason: 'hidden', retryCount: 0 });
    expect(excluded.indexed).toBeUndefined();
    const removed = apply(indexedState(), { kind: 'removed', reason: 'deleted' });
    expect(removed).toMatchObject({ status: 'removed', statusReason: 'deleted', observed: source });
    expect(removed.indexed).toBeUndefined();
    expect(removed.lastSuccessfulIndexAt).toBe('2026-02-01T11:00:00.000Z');
  });

  it('rejects events that need an existing state', () => {
    expect(() => transition(undefined, { kind: 'removed', reason: 'deleted' }, context)).toThrow(
      InvalidTransitionError,
    );
    expect(() =>
      transition(undefined, { kind: 'content_unchanged', source, fileHash: FILE_HASH }, context),
    ).toThrow(InvalidTransitionError);
  });

  it('caps the backoff', () => {
    expect(retryDelayMs(1, 600_000, 3_600_000)).toBe(600_000);
    expect(retryDelayMs(3, 600_000, 3_600_000)).toBe(2_400_000);
    expect(retryDelayMs(10, 600_000, 3_600_000)).toBe(3_600_000);
    expect(retryDelayMs(1_000, 600_000, 3_600_000)).toBe(3_600_000);
  });
});

describe('failure classification', () => {
  it('maps extraction failures to transient or permanent', () => {
    expect(classifyExtractionFailure('timeout')).toEqual({
      scope: 'transient',
      category: 'extraction_timeout',
    });
    expect(classifyExtractionFailure('extractor_error').scope).toBe('transient');
    for (const reason of [
      'encrypted',
      'corrupt',
      'empty',
      'input_too_large',
      'archive_limit_exceeded',
      'unsafe_archive_entry',
    ] as const) {
      expect(classifyExtractionFailure(reason).scope).toBe('permanent');
    }
  });

  it('maps Moodle errors', () => {
    expect(classifyError(new MoodleAuthenticationError('x', { code: 'invalid_token' }))).toEqual({
      scope: 'job',
      category: 'moodle_authentication',
    });
    expect(classifyError(new MoodleAuthorizationError('x', { code: 'http_403' }))).toEqual({
      scope: 'transient',
      category: 'moodle_file_forbidden',
    });
    expect(
      classifyError(
        new MoodleAuthorizationError('x', {
          code: 'nopermissions',
          functionName: 'core_course_get_contents',
        }),
      ).scope,
    ).toBe('job');
    expect(classifyError(new MoodleRateLimitError('x', { code: 'http_429' })).category).toBe(
      'moodle_throttled',
    );
    expect(classifyError(new MoodleTransportError('x', { code: 'timeout' })).category).toBe(
      'moodle_unavailable',
    );
    expect(classifyError(new MoodleTransportError('x', { code: 'aborted' }))).toEqual({
      scope: 'job',
      category: 'cancelled',
    });
    expect(classifyError(new MoodleValidationError('x', { code: 'file_too_large' }))).toEqual({
      scope: 'permanent',
      category: 'file_too_large',
    });
    expect(
      classifyError(new MoodleValidationError('x', { code: 'unsafe_redirect' })).category,
    ).toBe('unsafe_download');
    expect(classifyError(new MoodleValidationError('x', { code: 'login_redirect' })).scope).toBe(
      'job',
    );
    expect(
      classifyError(new MoodleApiError('x', { code: 'http_404', httpStatus: 404 })).category,
    ).toBe('moodle_file_not_found');
  });

  it('maps embedding and search errors', () => {
    expect(classifyError(new EmbeddingError('x', { category: 'throttled' }))).toEqual({
      scope: 'transient',
      category: 'embedding_unavailable',
    });
    expect(classifyError(new EmbeddingError('x', { category: 'authentication' })).scope).toBe(
      'job',
    );
    expect(classifyError(new EmbeddingError('x', { category: 'input_too_long' })).scope).toBe(
      'permanent',
    );
    expect(
      classifyError(
        new SearchServiceError('x', { category: 'unavailable', operation: 'indexDocuments' }),
      ).category,
    ).toBe('index_unavailable');
    expect(
      classifyError(
        new SearchServiceError('x', { category: 'not_found', operation: 'indexDocuments' }),
      ).scope,
    ).toBe('job');
  });

  it('maps internal errors', () => {
    expect(classifyError(new SyncStateConflictError()).category).toBe('state_conflict');
    expect(classifyError(new VectorDimensionError(4, 8)).scope).toBe('job');
    expect(classifyError(new InvalidSearchDocumentError(['content'])).scope).toBe('permanent');
    expect(classifyError(new DOMException('aborted', 'AbortError')).scope).toBe('job');
    expect(classifyError(new Error('boom'))).toEqual({
      scope: 'transient',
      category: 'unexpected_error',
    });
  });
});
