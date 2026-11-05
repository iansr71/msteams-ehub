import type { Logger } from '@ehub/shared';

import type { AuthorizationServices } from '../authorization/factory.js';
import type { ChatModelProvider } from '../rag/chatModelProvider.js';
import type { QueryEmbedder, SearchPort } from '../retrieval/retrievalService.js';
import { ReadinessService, expectHealthy, type DependencyCheck } from './readiness.js';

interface HealthCheckable<R> {
  healthCheck(options: { readonly signal?: AbortSignal }): Promise<R>;
}

function hasHealthCheck<R>(value: unknown): value is HealthCheckable<R> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'healthCheck' in value &&
    typeof value.healthCheck === 'function'
  );
}

export interface ApiReadinessInputs {
  readonly search: SearchPort;
  readonly embedder: QueryEmbedder | undefined;
  readonly model: ChatModelProvider;
  readonly authorization: AuthorizationServices | undefined;
  /** The sync state store, when the administration area reads it. */
  readonly syncState?: { listJobs(limit: number): Promise<unknown> };
  readonly logger: Logger;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
}

/**
 * The answer API's dependencies. Search, embeddings and the chat model are needed for every
 * answer; Moodle and the state stores only when course authorisation (and the administration
 * area) are configured.
 */
export function createApiReadiness(inputs: ApiReadinessInputs): ReadinessService {
  const { search, embedder, model, authorization, syncState } = inputs;
  const moodle = authorization?.moodle;
  const checks: DependencyCheck[] = [
    {
      name: 'search',
      required: true,
      probe: hasHealthCheck<{ status: string }>(search)
        ? expectHealthy(
            // `degraded` still serves queries: it means a data-plane-only credential cannot read
            // service statistics, or the index has pending compatible changes.
            async (signal) => (await search.healthCheck({ signal })).status !== 'unhealthy',
            'unhealthy',
          )
        : undefined,
    },
    {
      name: 'embedding',
      required: true,
      probe: hasHealthCheck<{ status: string }>(embedder)
        ? expectHealthy(
            async (signal) => (await embedder.healthCheck({ signal })).status === 'healthy',
            'unhealthy',
          )
        : undefined,
    },
    {
      name: 'chat',
      required: true,
      // A tiny fixed prompt: proves the deployment answers, for a few tokens per cache period.
      probe: async (signal) => {
        await model.complete({
          messages: [
            { role: 'system', content: 'Health check. Reply with the single word OK.' },
            { role: 'user', content: 'OK?' },
          ],
          maxOutputTokens: 16,
          signal,
        });
      },
    },
    {
      name: 'moodle',
      required: authorization !== undefined,
      probe:
        moodle !== undefined && 'getSiteInfo' in moodle && typeof moodle.getSiteInfo === 'function'
          ? async (signal) => {
              await (
                moodle as { getSiteInfo(options: { signal: AbortSignal }): Promise<unknown> }
              ).getSiteInfo({ signal });
            }
          : undefined,
    },
    {
      name: 'state_store',
      required: authorization !== undefined || syncState !== undefined,
      probe:
        authorization === undefined && syncState === undefined
          ? undefined
          : async () => {
              await authorization?.repository.listInvalidations();
              await syncState?.listJobs(1);
            },
    },
  ];
  return new ReadinessService({
    checks,
    logger: inputs.logger,
    ...(inputs.cacheMs === undefined ? {} : { cacheMs: inputs.cacheMs }),
    ...(inputs.timeoutMs === undefined ? {} : { timeoutMs: inputs.timeoutMs }),
  });
}
