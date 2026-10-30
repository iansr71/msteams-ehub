import type {
  MoodleClient,
  MoodleFileDownloader,
  NormalizedMoodleBaseUrl,
} from '@ehub/moodle-client';
import type { Logger } from '@ehub/shared';
import type { EmbeddingProvider } from '@ehub/shared/embeddings';
import type { SearchIndexClient } from '@ehub/shared/search';

import type { ExtractorRegistry } from '../extractors/extractorRegistry.js';
import type { StructuredChunker } from '../pipeline/chunkContent.js';
import type { Clock, SyncStateRepository } from '../state/syncStateRepository.js';
import type { SyncJobType } from '../state/syncState.js';
import type { PipelineVersions } from './fingerprints.js';
import type { SyncReportBuilder } from './syncReport.js';

export interface SyncSettings {
  readonly tenantId: string;
  /** Explicit course selection; undefined with `allCourses`. */
  readonly courseIds: readonly number[] | undefined;
  readonly allCourses: boolean;
  readonly includeHidden: boolean;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly leaseTtlMs: number;
  readonly maxDeleteFraction: number;
  readonly maxDeleteMinimum: number;
  /** Download ceiling: the smaller of the Moodle and extraction limits. */
  readonly maxDownloadBytes: number;
}

/** The search operations synchronisation needs. */
export type SyncSearchIndex = Pick<
  SearchIndexClient,
  'uploadChunks' | 'listChunkKeys' | 'deleteChunksByKeys' | 'deleteChunksByResource'
>;

/** Every external dependency of the jobs, injected so tests can use fakes. */
export interface SyncServices {
  readonly moodle: {
    readonly client: MoodleClient;
    readonly baseUrl: NormalizedMoodleBaseUrl;
    readonly downloader: MoodleFileDownloader;
  };
  readonly extractors: ExtractorRegistry;
  readonly chunker: StructuredChunker;
  readonly embedder: EmbeddingProvider;
  readonly search: SyncSearchIndex;
  readonly state: SyncStateRepository;
  readonly versions: PipelineVersions;
  readonly settings: SyncSettings;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface JobOptions {
  /** Report what would happen; download, index and store nothing. */
  readonly dryRun: boolean;
  /** Reprocess every selected resource regardless of state. */
  readonly force: boolean;
  /** Allow removals beyond the deletion guard. */
  readonly allowMassDelete: boolean;
  /** `sync:retry-failed` only: also retry dead-lettered resources. */
  readonly includeDeadLetter: boolean;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  dryRun: false,
  force: false,
  allowMassDelete: false,
  includeDeadLetter: false,
};

/** One running job: identity, options and its report. */
export interface SyncJob {
  readonly jobId: string;
  readonly jobType: SyncJobType;
  readonly options: JobOptions;
  readonly services: SyncServices;
  readonly report: SyncReportBuilder;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
}

/** A failure that affects every resource; the job stops without changing resource state. */
export class SyncJobAbortedError extends Error {
  constructor(readonly category: string) {
    super(`Synchronisation stopped: ${category}.`);
    this.name = 'SyncJobAbortedError';
  }
}

export class SyncSelectionError extends Error {
  readonly code: 'no_course_selection' | 'course_not_selected';

  constructor(code: 'no_course_selection' | 'course_not_selected') {
    super(
      code === 'no_course_selection'
        ? 'No courses are selected for synchronisation. Set SYNC_COURSE_IDS, or SYNC_ALL_COURSES=true.'
        : 'The course is not in SYNC_COURSE_IDS, so it is not synchronised (and reconciliation would remove it).',
    );
    this.name = 'SyncSelectionError';
    this.code = code;
  }
}
