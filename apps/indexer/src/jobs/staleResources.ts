import type { IndexedChunkKey } from '@ehub/shared/search';

import type { StoredResourceState } from '../state/syncState.js';
import { classifyError } from './failureClassification.js';
import { removeResource } from './syncResource.js';
import { SyncJobAbortedError, type SyncJob } from './syncContext.js';

/**
 * The deletion guard: whether removing `removing` of `indexed` resources (or courses) at once is
 * plausible. A Moodle outage or permission change can return an empty course; this keeps such a
 * glitch from emptying the index. `--allow-mass-delete` overrides it.
 */
export function deletionAllowed(
  job: SyncJob,
  removing: number,
  indexed: number,
  minimum = job.services.settings.maxDeleteMinimum,
): boolean {
  if (job.options.allowMassDelete || removing <= minimum) {
    return true;
  }
  return removing <= job.services.settings.maxDeleteFraction * indexed;
}

export interface StaleRemovalInput {
  readonly courseId: number;
  /** Resource IDs Moodle currently lists for the course. */
  readonly listedIds: ReadonlySet<string>;
  readonly states: Map<string, StoredResourceState>;
  /** The course's chunks in the index, when they were listed (full sync and reconciliation). */
  readonly indexKeys?: readonly IndexedChunkKey[];
  readonly reason: string;
  /** Apply the deletion guard (default). */
  readonly guard?: boolean;
}

/**
 * Removes resources Moodle no longer lists: those state knows about, and (when index keys are
 * given) chunks with no state at all. Returns how many removals the deletion guard blocked.
 */
export async function removeStaleResources(
  job: SyncJob,
  input: StaleRemovalInput,
): Promise<number> {
  const stale = [...input.states.values()].filter(
    (state) => state.status !== 'removed' && !input.listedIds.has(state.resourceId),
  );
  const orphanKeys = (input.indexKeys ?? []).filter(
    (key) => !input.listedIds.has(key.resourceId) && !input.states.has(key.resourceId),
  );
  const orphanResources = [...new Set(orphanKeys.map((key) => key.resourceId))];

  const withChunks =
    stale.filter((state) => state.indexed !== undefined).length + orphanResources.length;
  const indexedTotal =
    [...input.states.values()].filter((state) => state.indexed !== undefined).length +
    orphanResources.length;
  if (input.guard !== false && !deletionAllowed(job, withChunks, indexedTotal)) {
    job.report.warn('deletion_guard');
    job.logger.warn(
      'Deletion guard blocked removals; Moodle may have returned an incomplete course.',
      {
        courseId: input.courseId,
        removing: withChunks,
        indexed: indexedTotal,
      },
    );
    return withChunks;
  }

  for (const state of stale) {
    await removeResource(job, input.states, state, input.reason);
  }
  for (const resourceId of orphanResources) {
    const keys = orphanKeys.filter((key) => key.resourceId === resourceId).map((key) => key.id);
    if (job.options.dryRun) {
      job.report.addResource({
        courseId: input.courseId,
        resourceId,
        action: 'would_remove',
        reasons: ['orphaned_chunks'],
        chunksRemoved: keys.length,
      });
      continue;
    }
    try {
      const report = await job.services.search.deleteChunksByKeys(
        keys,
        job.signal === undefined ? {} : { signal: job.signal },
      );
      job.report.addResource(
        report.failed.length > 0
          ? {
              courseId: input.courseId,
              resourceId,
              action: 'failed',
              reasons: ['orphaned_chunks'],
              failureCategory: 'index_partial_failure',
            }
          : {
              courseId: input.courseId,
              resourceId,
              action: 'removed',
              reasons: ['orphaned_chunks'],
              chunksRemoved: report.succeeded,
            },
      );
    } catch (error) {
      const classification = classifyError(error);
      if (classification.scope === 'job') {
        throw new SyncJobAbortedError(classification.category);
      }
      job.report.addResource({
        courseId: input.courseId,
        resourceId,
        action: 'failed',
        reasons: ['orphaned_chunks'],
        failureCategory: classification.category,
      });
    }
  }
  return 0;
}
