import { getTelemetry } from '@ehub/shared';

import { RESOURCE_STATUSES, type ResourceStatus } from '../state/syncState.js';
import type { SyncStateRepository } from '../state/syncStateRepository.js';

export interface SyncHealthSnapshot {
  /** Seconds since the last successful (non-dry-run) job finished; undefined if never. */
  readonly lagSeconds: number | undefined;
  readonly resources: Readonly<Record<ResourceStatus, number>>;
}

/**
 * Reads the sync state and reports the sync-lag and resource-status gauges. Run after each job
 * (indexer) and periodically by the API, so a stalled scheduler shows as growing lag.
 */
export async function reportSyncGauges(
  state: Pick<SyncStateRepository, 'listJobs' | 'listResources'>,
  tenantId: string,
  now: Date,
): Promise<SyncHealthSnapshot> {
  const [jobs, resources] = await Promise.all([
    state.listJobs(200),
    state.listResources({ tenantId }),
  ]);
  const lastSuccess = jobs.find(
    (job) => job.status === 'succeeded' && !job.dryRun && job.finishedAt !== undefined,
  );
  const lagSeconds =
    lastSuccess?.finishedAt === undefined
      ? undefined
      : Math.max(0, Math.round((now.getTime() - Date.parse(lastSuccess.finishedAt)) / 1000));
  const counts = Object.fromEntries(RESOURCE_STATUSES.map((status) => [status, 0])) as Record<
    ResourceStatus,
    number
  >;
  for (const resource of resources) {
    counts[resource.status] += 1;
  }
  const telemetry = getTelemetry();
  if (lagSeconds !== undefined) {
    telemetry.gauge('ehub.sync.lag', lagSeconds);
  }
  for (const status of RESOURCE_STATUSES) {
    telemetry.gauge('ehub.sync.resources', counts[status], { status });
  }
  return { lagSeconds, resources: counts };
}
