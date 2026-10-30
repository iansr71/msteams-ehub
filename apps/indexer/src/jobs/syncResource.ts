import {
  CourseNotFoundError,
  ResourceNotFoundError,
  findCourseResource,
} from '../moodle/inspectCourse.js';
import type { CourseResource, CourseStructure } from '../moodle/models.js';
import type { ResourceState, StoredResourceState } from '../state/syncState.js';
import { isSyncStateConflict } from '../state/syncStateRepository.js';
import { decideResource, type DecisionMode } from './changeDetection.js';
import { classifyError } from './failureClassification.js';
import { sourceFingerprint } from './fingerprints.js';
import { removeResourceChunks } from './indexReplacement.js';
import { processResource, type ProcessOutcome } from './processResource.js';
import { loadCourseStructure, withCourseLease } from './courseAccess.js';
import { SyncJobAbortedError, type SyncJob } from './syncContext.js';
import type { ResourceAction, ResourceReportEntry } from './syncReport.js';
import { transition, type ResourceEvent } from './stateTransitions.js';

export interface CourseSyncContext {
  readonly structure: CourseStructure;
  readonly courseHidden: boolean;
  /** Stored state for the course, by resource ID; updated as resources are saved. */
  readonly states: Map<string, StoredResourceState>;
}

function actionFor(event: ResourceEvent, state: ResourceState): ResourceAction {
  switch (event.kind) {
    case 'indexed':
      return 'indexed';
    case 'content_unchanged':
      return 'skipped';
    case 'excluded':
      return 'excluded';
    case 'removed':
      return 'removed';
    case 'transient_failure':
      return state.status === 'dead_letter' ? 'dead_letter' : 'failed';
    case 'permanent_failure':
      return 'quarantined';
  }
}

/**
 * Saves the next state. A conflict means another process changed the record despite the
 * course lease (for example after the lease expired); the result is reported, not retried,
 * and the next run sees the newer state.
 */
async function saveState(
  job: SyncJob,
  states: Map<string, StoredResourceState>,
  resource: Pick<CourseResource, 'courseId' | 'resourceId' | 'moduleId'>,
  event: ResourceEvent,
): Promise<{ state: ResourceState } | { conflict: true }> {
  const { services } = job;
  const previous = states.get(resource.resourceId);
  const next = transition(previous, event, {
    tenantId: services.settings.tenantId,
    courseId: resource.courseId,
    resourceId: resource.resourceId,
    moduleId: resource.moduleId,
    jobId: job.jobId,
    jobType: job.jobType,
    now: services.clock.now(),
    maxAttempts: services.settings.maxAttempts,
    retryBaseDelayMs: services.settings.retryBaseDelayMs,
    retryMaxDelayMs: services.settings.retryMaxDelayMs,
  });
  try {
    const stored = await services.state.saveResource(next, previous?.revision ?? null);
    states.set(resource.resourceId, stored);
    return { state: stored };
  } catch (error) {
    if (isSyncStateConflict(error)) {
      return { conflict: true };
    }
    throw error;
  }
}

function entryFor(
  resource: Pick<CourseResource, 'courseId' | 'resourceId'>,
  action: ResourceAction,
  details: Omit<ResourceReportEntry, 'courseId' | 'resourceId' | 'action'> = {},
): ResourceReportEntry {
  return { courseId: resource.courseId, resourceId: resource.resourceId, action, ...details };
}

/** Records the outcome of an event: state first, then the report. */
async function record(
  job: SyncJob,
  states: Map<string, StoredResourceState>,
  resource: Pick<CourseResource, 'courseId' | 'resourceId' | 'moduleId'>,
  event: ResourceEvent,
  details: Omit<ResourceReportEntry, 'courseId' | 'resourceId' | 'action'>,
): Promise<void> {
  const saved = await saveState(job, states, resource, event);
  if ('conflict' in saved) {
    job.report.addResource(
      entryFor(resource, 'failed', { ...details, failureCategory: 'state_conflict' }),
    );
    job.logger.warn('Resource state changed by another process; result not recorded.', {
      courseId: resource.courseId,
      resourceId: resource.resourceId,
    });
    return;
  }
  const action = actionFor(event, saved.state);
  const failureCategory =
    event.kind === 'transient_failure' || event.kind === 'permanent_failure'
      ? event.category
      : undefined;
  job.report.addResource(
    entryFor(resource, action, {
      ...details,
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(action === 'failed' || action === 'dead_letter'
        ? { retryCount: saved.state.retryCount }
        : {}),
    }),
  );
  const level =
    action === 'failed' || action === 'dead_letter' || action === 'quarantined' ? 'warn' : 'info';
  job.logger[level]('Resource synchronised.', {
    courseId: resource.courseId,
    resourceId: resource.resourceId,
    action,
    ...(failureCategory === undefined ? {} : { failureCategory }),
    ...(details.chunks === undefined ? {} : { chunks: details.chunks }),
  });
}

/** Decides and applies the change for one resource Moodle lists. */
export async function syncListedResource(
  job: SyncJob,
  context: CourseSyncContext,
  resource: CourseResource,
  mode: DecisionMode,
): Promise<void> {
  const { services, options } = job;
  const state = context.states.get(resource.resourceId);
  const source = sourceFingerprint(resource, context.structure.course);
  const decision = decideResource({
    resource,
    courseHidden: context.courseHidden,
    source,
    state,
    versions: services.versions,
    mode,
    force: options.force,
    includeHidden: services.settings.includeHidden,
    includeDeadLetter: options.includeDeadLetter,
    now: services.clock.now(),
  });

  if (decision.kind === 'skip') {
    job.report.addResource(entryFor(resource, 'skipped', { reasons: [decision.reason] }));
    return;
  }

  if (decision.kind === 'exclude') {
    if (options.dryRun) {
      job.report.addResource(
        entryFor(resource, 'would_exclude', {
          reasons: [decision.reason],
          // Unknown until the index is queried; reported as a removal when chunks are recorded.
          ...(state?.indexed === undefined ? {} : { chunksRemoved: state.indexed.chunkCount }),
        }),
      );
      return;
    }
    let chunksRemoved: number;
    try {
      chunksRemoved = await removeResourceChunks(
        services.search,
        {
          tenantId: services.settings.tenantId,
          courseId: resource.courseId,
          resourceId: resource.resourceId,
        },
        job.signal,
      );
    } catch (error) {
      const classification = classifyError(error);
      if (classification.scope === 'job') {
        throw new SyncJobAbortedError(classification.category);
      }
      // The exclusion is retried on the next run, because the state is not updated.
      job.report.addResource(
        entryFor(resource, 'failed', {
          reasons: [decision.reason],
          failureCategory: classification.category,
        }),
      );
      return;
    }
    await record(
      job,
      context.states,
      resource,
      { kind: 'excluded', source, reason: decision.reason },
      { reasons: [decision.reason], ...(chunksRemoved > 0 ? { chunksRemoved } : {}) },
    );
    return;
  }

  if (options.dryRun) {
    job.report.addResource(entryFor(resource, 'would_index', { reasons: decision.reasons }));
    return;
  }
  const outcome: ProcessOutcome = await processResource(
    job,
    context.structure,
    resource,
    decision.reasons,
    state,
    source,
  );
  await record(job, context.states, resource, outcome.event, {
    reasons: outcome.event.kind === 'content_unchanged' ? ['content_unchanged'] : decision.reasons,
    ...(outcome.chunks === undefined ? {} : { chunks: outcome.chunks }),
    ...(outcome.staleChunksRemoved === undefined
      ? {}
      : { staleChunksRemoved: outcome.staleChunksRemoved }),
    ...(outcome.chunksRemoved === undefined ? {} : { chunksRemoved: outcome.chunksRemoved }),
    ...(outcome.embeddings === undefined ? {} : { embeddings: outcome.embeddings }),
  });
}

/** Removes a resource Moodle no longer lists (or that is no longer selected). */
export async function removeResource(
  job: SyncJob,
  states: Map<string, StoredResourceState>,
  state: StoredResourceState,
  reason: string,
): Promise<void> {
  const resource = {
    courseId: state.courseId,
    resourceId: state.resourceId,
    moduleId: state.moduleId,
  };
  if (job.options.dryRun) {
    job.report.addResource(entryFor(resource, 'would_remove', { reasons: [reason] }));
    return;
  }
  let chunksRemoved: number;
  try {
    chunksRemoved = await removeResourceChunks(
      job.services.search,
      { tenantId: state.tenantId, courseId: state.courseId, resourceId: state.resourceId },
      job.signal,
    );
  } catch (error) {
    const classification = classifyError(error);
    if (classification.scope === 'job') {
      throw new SyncJobAbortedError(classification.category);
    }
    job.report.addResource(
      entryFor(resource, 'failed', { reasons: [reason], failureCategory: classification.category }),
    );
    return;
  }
  await record(
    job,
    states,
    resource,
    { kind: 'removed', reason },
    { reasons: [reason], ...(chunksRemoved > 0 ? { chunksRemoved } : {}) },
  );
}

export class ResourceSelectionError extends Error {
  constructor() {
    super('The resource is not in a course selected for synchronisation.');
    this.name = 'ResourceSelectionError';
  }
}

/**
 * `sync:resource`: one resource, under its course's lease. A resource Moodle no longer lists is
 * removed (with its chunks) when state knows it; otherwise ResourceNotFoundError.
 */
export async function syncSingleResource(
  job: SyncJob,
  courseId: number,
  resourceId: string,
): Promise<void> {
  await withCourseLease(job, courseId, async () => {
    const { services } = job;
    let structure: CourseStructure;
    try {
      structure = await loadCourseStructure(job, courseId);
    } catch (error) {
      if (error instanceof CourseNotFoundError) {
        job.report.addCourse({ courseId, outcome: 'not_found' });
        return;
      }
      throw error;
    }
    const states = new Map(
      (await services.state.listResources({ tenantId: services.settings.tenantId, courseId })).map(
        (state) => [state.resourceId, state] as const,
      ),
    );
    const context: CourseSyncContext = {
      structure,
      courseHidden: structure.course.visible === false,
      states,
    };
    let resource: CourseResource;
    try {
      resource = findCourseResource(structure, resourceId);
    } catch (error) {
      const known = states.get(resourceId);
      if (
        error instanceof ResourceNotFoundError &&
        known !== undefined &&
        known.status !== 'removed'
      ) {
        await removeResource(job, states, known, 'deleted');
        job.report.addCourse({ courseId, outcome: 'synced' });
        return;
      }
      throw error;
    }
    await syncListedResource(job, context, resource, 'single');
    job.report.addCourse({ courseId, outcome: 'synced' });
  });
}
