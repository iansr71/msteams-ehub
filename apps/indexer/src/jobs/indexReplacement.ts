import type { SearchDocument } from '@ehub/shared/search';

import type { SyncSearchIndex } from './syncContext.js';

export interface ResourceScope {
  readonly tenantId: string;
  readonly courseId: number;
  readonly resourceId: string;
}

export class IndexReplacementError extends Error {
  constructor(
    readonly stage: 'upload' | 'delete',
    readonly failedDocuments: number,
  ) {
    super(
      `${String(failedDocuments)} document(s) failed during ${stage === 'upload' ? 'upload' : 'stale chunk removal'}.`,
    );
    this.name = 'IndexReplacementError';
  }
}

export interface ReplacementResult {
  readonly uploaded: number;
  readonly staleRemoved: number;
}

/**
 * Replaces a resource's chunks as atomically as Azure AI Search allows. Azure has no
 * transactions, so:
 * 1. every new chunk is built and embedded before this is called (nothing is touched while
 *    the new version is not ready);
 * 2. chunk keys are deterministic per resource and chunk number, so uploading overwrites the
 *    previous version in place: the resource stays searchable throughout, and a resource of up
 *    to AZURE_SEARCH_BATCH_SIZE chunks changes in a single request;
 * 3. only after every upload succeeded are leftover chunks (the old version had more) removed.
 * If an upload partly fails, nothing is removed and the error marks the resource for retry;
 * until then some chunks may be from the new version and some from the old.
 */
export async function replaceResourceChunks(
  search: SyncSearchIndex,
  scope: ResourceScope,
  documents: readonly SearchDocument[],
  signal?: AbortSignal,
): Promise<ReplacementResult> {
  const options = signal === undefined ? {} : { signal };
  const upload = await search.uploadChunks(documents, options);
  if (upload.failed.length > 0 || upload.succeeded !== documents.length) {
    throw new IndexReplacementError('upload', Math.max(upload.failed.length, 1));
  }
  const keep = new Set(documents.map((document) => document.id));
  const existing = await search.listChunkKeys(scope, options);
  const stale = existing
    .filter((entry) => entry.resourceId === scope.resourceId && !keep.has(entry.id))
    .map((entry) => entry.id);
  if (stale.length === 0) {
    return { uploaded: documents.length, staleRemoved: 0 };
  }
  const removal = await search.deleteChunksByKeys(stale, options);
  if (removal.failed.length > 0) {
    throw new IndexReplacementError('delete', removal.failed.length);
  }
  return { uploaded: documents.length, staleRemoved: stale.length };
}

/** Removes every chunk of a resource; returns how many there were. */
export async function removeResourceChunks(
  search: SyncSearchIndex,
  scope: ResourceScope,
  signal?: AbortSignal,
): Promise<number> {
  const report = await search.deleteChunksByResource(scope, signal === undefined ? {} : { signal });
  if (report.failed.length > 0) {
    throw new IndexReplacementError('delete', report.failed.length);
  }
  return report.matched;
}
