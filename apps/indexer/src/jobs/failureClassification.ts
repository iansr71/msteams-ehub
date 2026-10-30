import { isMoodleError } from '@ehub/moodle-client';
import { isEmbeddingError } from '@ehub/shared/embeddings';
import { isSearchServiceError } from '@ehub/shared/search';

import type { ExtractionFailureReason } from '../extractors/types.js';
import { InvalidSearchDocumentError, VectorDimensionError } from '../search/searchDocuments.js';
import { SyncStateCorruptError, isSyncStateConflict } from '../state/syncStateRepository.js';
import type { FailureCategory } from '../state/syncState.js';
import { IndexReplacementError } from './indexReplacement.js';
import { SyncJobAbortedError } from './syncContext.js';

/**
 * - `transient`: retried with backoff, then dead-lettered.
 * - `permanent`: quarantined until the source or an extractor changes.
 * - `job`: affects every resource (credentials, missing index, cancellation). The job stops and
 *   the resource's state is left untouched, so an outage does not burn retry budgets.
 */
export type FailureClassification =
  | { readonly scope: 'transient'; readonly category: FailureCategory }
  | { readonly scope: 'permanent'; readonly category: FailureCategory }
  | { readonly scope: 'job'; readonly category: string };

const transient = (category: FailureCategory): FailureClassification => ({
  scope: 'transient',
  category,
});
const permanent = (category: FailureCategory): FailureClassification => ({
  scope: 'permanent',
  category,
});
const job = (category: string): FailureClassification => ({ scope: 'job', category });

export function classifyExtractionFailure(reason: ExtractionFailureReason): FailureClassification {
  switch (reason) {
    case 'timeout':
      return transient('extraction_timeout');
    case 'extractor_error':
      return transient('extractor_error');
    case 'input_too_large':
      return permanent('file_too_large');
    case 'encrypted':
      return permanent('encrypted');
    case 'corrupt':
      return permanent('corrupt');
    case 'empty':
      return permanent('empty');
    case 'archive_limit_exceeded':
      return permanent('archive_limit_exceeded');
    case 'unsafe_archive_entry':
      return permanent('unsafe_archive_entry');
  }
}

/** Every unsupported-content reason is permanent for the same bytes. */
export const UNSUPPORTED_CONTENT_FAILURE: FailureClassification = permanent('unsupported_content');

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Maps an error thrown while processing one resource to a sanitised category. */
export function classifyError(error: unknown): FailureClassification {
  if (isAbort(error)) {
    return job('cancelled');
  }
  if (error instanceof SyncJobAbortedError) {
    return job(error.category);
  }
  if (error instanceof IndexReplacementError) {
    return transient('index_partial_failure');
  }
  if (error instanceof SyncStateCorruptError) {
    return job('state_corrupt');
  }
  if (isSyncStateConflict(error)) {
    return transient('state_conflict');
  }
  if (error instanceof VectorDimensionError) {
    return job('dimension_mismatch');
  }
  if (error instanceof InvalidSearchDocumentError) {
    return permanent('invalid_chunk');
  }
  if (isMoodleError(error)) {
    if (error.code === 'aborted') {
      return job('cancelled');
    }
    switch (error.category) {
      case 'authentication':
        return job('moodle_authentication');
      case 'authorization':
        // A web-service call refused means the token lacks a capability (every course is
        // affected); a refused file download can be specific to that file.
        return error.functionName === undefined
          ? transient('moodle_file_forbidden')
          : job('moodle_authorization');
      case 'rate_limit':
        return transient('moodle_throttled');
      case 'transport':
        return transient('moodle_unavailable');
      case 'validation':
        if (error.code === 'file_too_large') {
          return permanent('file_too_large');
        }
        if (error.code === 'login_redirect') {
          return job('moodle_authentication');
        }
        if (
          error.code === 'unsafe_redirect' ||
          error.code === 'invalid_redirect' ||
          error.code === 'too_many_redirects'
        ) {
          return permanent('unsafe_download');
        }
        return transient('moodle_error');
      case 'api':
        return error.httpStatus === 404
          ? transient('moodle_file_not_found')
          : transient('moodle_error');
    }
  }
  if (isEmbeddingError(error)) {
    switch (error.category) {
      case 'authentication':
      case 'authorization':
      case 'not_found':
      case 'dimension_mismatch':
        return job(`embedding_${error.category}`);
      case 'cancelled':
        return job('cancelled');
      case 'invalid_input':
      case 'input_too_long':
        return permanent('embedding_input_rejected');
      case 'invalid_response':
      case 'invalid_request':
        return transient('embedding_rejected_response');
      case 'throttled':
      case 'unavailable':
      case 'timeout':
      case 'network':
        return transient('embedding_unavailable');
    }
  }
  if (isSearchServiceError(error)) {
    switch (error.category) {
      case 'authentication':
      case 'authorization':
      case 'access_denied':
      case 'not_found':
        return job(`index_${error.category}`);
      case 'cancelled':
        return job('cancelled');
      case 'invalid_request':
      case 'request_too_large':
      case 'invalid_response':
      case 'conflict':
      case 'precondition_failed':
        return transient('index_rejected');
      case 'throttled':
      case 'unavailable':
      case 'timeout':
      case 'network':
        return transient('index_unavailable');
    }
  }
  return transient('unexpected_error');
}
