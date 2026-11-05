import { InMemoryTelemetry, createLogger, resetTelemetry, setTelemetry } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthorizationServices } from '../authorization/factory.js';
import type { ChatModelProvider, ChatCompletionRequest } from '../rag/chatModelProvider.js';
import type { QueryEmbedder, SearchPort } from '../retrieval/retrievalService.js';
import { createApiReadiness } from './apiReadiness.js';
import { ReadinessService, expectHealthy, type DependencyCheck } from './readiness.js';

const logs: string[] = [];
const logger = createLogger({ service: 'test', sink: { write: (line) => logs.push(line) } });

afterEach(() => {
  resetTelemetry();
  logs.length = 0;
});

function failing(category: string, message = 'GET https://x.example/?token=s3cret failed') {
  return () => Promise.reject(Object.assign(new Error(message), { category }));
}

function clock(start = 0) {
  let ms = start;
  return {
    now: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
  };
}

describe('ReadinessService', () => {
  it('is ready when every required dependency is up, whatever optional ones do', async () => {
    const service = new ReadinessService({
      checks: [
        { name: 'search', required: true, probe: () => Promise.resolve() },
        { name: 'moodle', required: false, probe: failing('network') },
        { name: 'state_store', required: false, probe: undefined },
      ],
      logger,
    });
    const report = await service.report();
    expect(report.status).toBe('ready');
    expect(report.dependencies.map((d) => [d.name, d.status, d.category])).toEqual([
      ['search', 'up', null],
      ['moodle', 'down', 'network'],
      ['state_store', 'not_configured', null],
    ]);
  });

  it('is not ready when a required dependency is down or has no probe', async () => {
    for (const checks of [
      [{ name: 'search', required: true, probe: failing('timeout') }],
      [{ name: 'search', required: true, probe: undefined }],
    ] satisfies DependencyCheck[][]) {
      expect((await new ReadinessService({ checks, logger }).report()).status).toBe('not_ready');
    }
  });

  it('reports only the sanitised category, never the error message', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const service = new ReadinessService({
      checks: [
        { name: 'chat', required: true, probe: failing('authentication') },
        { name: 'search', required: true, probe: () => Promise.reject(new Error('s3cret')) },
      ],
      logger,
    });
    const report = await service.report();
    expect(report.dependencies.map((d) => d.category)).toEqual(['authentication', 'unexpected']);
    const everything =
      JSON.stringify(report) +
      logs.join('\n') +
      JSON.stringify(memory.spans.map((s) => s.attributes));
    expect(everything).not.toContain('s3cret');
    expect(everything).not.toContain('https://');
    expect(memory.spans.map((s) => [s.name, s.failureCategory])).toEqual([
      ['health.check', 'authentication'],
      ['health.check', 'unexpected'],
    ]);
  });

  it('times out a hung probe and aborts it', async () => {
    let aborted = false;
    const service = new ReadinessService({
      checks: [
        {
          name: 'moodle',
          required: true,
          probe: (signal) =>
            new Promise<void>(() => {
              signal.addEventListener('abort', () => {
                aborted = true;
              });
            }),
        },
      ],
      timeoutMs: 20,
      logger,
    });
    const report = await service.report();
    expect(report.status).toBe('not_ready');
    expect(report.dependencies[0]).toMatchObject({ status: 'down', category: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('reuses results within the cache period unless asked for fresh ones', async () => {
    const time = clock();
    let calls = 0;
    const service = new ReadinessService({
      checks: [
        {
          name: 'search',
          required: true,
          probe: () => {
            calls += 1;
            return Promise.resolve();
          },
        },
      ],
      cacheMs: 1_000,
      now: time.now,
      logger,
    });
    await service.report();
    time.advance(999);
    await service.report();
    expect(calls).toBe(1);
    await service.report({ fresh: true });
    expect(calls).toBe(2);
    time.advance(1_000);
    await service.report();
    expect(calls).toBe(3);
  });

  it('shares one probe between concurrent reports', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const service = new ReadinessService({
      checks: [
        {
          name: 'search',
          required: true,
          probe: () => {
            calls += 1;
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
      ],
      logger,
    });
    const both = Promise.all([service.report({ fresh: true }), service.report({ fresh: true })]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [first, second] = await both;
    expect(calls).toBe(1);
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
  });

  it('expectHealthy fails with the given category', async () => {
    await expect(
      expectHealthy(() => Promise.resolve(false), 'unhealthy')(new AbortController().signal),
    ).rejects.toMatchObject({
      category: 'unhealthy',
    });
    await expect(
      expectHealthy(() => Promise.resolve(true), 'unhealthy')(new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});

describe('createApiReadiness', () => {
  function inputs(
    overrides: {
      searchStatus?: 'healthy' | 'degraded' | 'unhealthy';
      embeddingStatus?: 'healthy' | 'unhealthy';
      chat?: () => Promise<void>;
    } = {},
  ) {
    const completions: ChatCompletionRequest[] = [];
    const search = {
      healthCheck: () => Promise.resolve({ status: overrides.searchStatus ?? 'healthy' }),
    } as unknown as SearchPort;
    const embedder = {
      healthCheck: () => Promise.resolve({ status: overrides.embeddingStatus ?? 'healthy' }),
    } as unknown as QueryEmbedder;
    const model = {
      complete: async (request: ChatCompletionRequest) => {
        completions.push(request);
        await (overrides.chat ?? (() => Promise.resolve()))();
        return { content: 'OK' };
      },
    } as unknown as ChatModelProvider;
    return { probes: { search, embedder, model }, completions };
  }

  function authorization(options: { moodleUp: boolean; storeUp: boolean }): AuthorizationServices {
    return {
      moodle: {
        getSiteInfo: options.moodleUp ? () => Promise.resolve({}) : failing('network'),
      },
      repository: {
        listInvalidations: options.storeUp ? () => Promise.resolve([]) : failing('io'),
      },
    } as unknown as AuthorizationServices;
  }

  it('checks search, embeddings and chat, and leaves Moodle optional without authorisation', async () => {
    const { completions, probes } = inputs();
    const report = await createApiReadiness({
      ...probes,
      authorization: undefined,
      logger,
    }).report();
    expect(report.status).toBe('ready');
    expect(report.dependencies.map((d) => [d.name, d.required, d.status])).toEqual([
      ['search', true, 'up'],
      ['embedding', true, 'up'],
      ['chat', true, 'up'],
      ['moodle', false, 'not_configured'],
      ['state_store', false, 'not_configured'],
    ]);
    // The chat probe is a tiny fixed prompt with no user or source content.
    expect(completions).toHaveLength(1);
    expect(completions[0]?.maxOutputTokens).toBe(16);
  });

  it('treats degraded search as up and unhealthy search as down', async () => {
    const degraded = createApiReadiness({
      ...inputs({ searchStatus: 'degraded' }).probes,
      authorization: undefined,
      logger,
    });
    expect((await degraded.report()).status).toBe('ready');
    const unhealthy = createApiReadiness({
      ...inputs({ searchStatus: 'unhealthy' }).probes,
      authorization: undefined,
      logger,
    });
    const report = await unhealthy.report();
    expect(report.status).toBe('not_ready');
    expect(report.dependencies[0]).toMatchObject({ status: 'down', category: 'unhealthy' });
  });

  it.each([
    ['embeddings', { embeddingStatus: 'unhealthy' as const }],
    ['chat', { chat: failing('throttled') }],
  ])('is not ready when %s fail', async (_label, overrides) => {
    const service = createApiReadiness({
      ...inputs(overrides).probes,
      authorization: undefined,
      logger,
    });
    expect((await service.report()).status).toBe('not_ready');
  });

  it('requires Moodle and the state store when authorisation is configured', async () => {
    const { probes } = inputs();
    const up = createApiReadiness({
      ...probes,
      authorization: authorization({ moodleUp: true, storeUp: true }),
      logger,
    });
    const upReport = await up.report();
    expect(upReport.status).toBe('ready');
    expect(upReport.dependencies.find((d) => d.name === 'moodle')).toMatchObject({
      required: true,
      status: 'up',
    });

    for (const state of [
      { moodleUp: false, storeUp: true },
      { moodleUp: true, storeUp: false },
    ]) {
      const down = createApiReadiness({ ...probes, authorization: authorization(state), logger });
      expect((await down.report()).status).toBe('not_ready');
    }
  });

  it('checks the sync state store when the administration area reads it', async () => {
    const { probes } = inputs();
    const service = createApiReadiness({
      ...probes,
      authorization: undefined,
      syncState: { listJobs: failing('io') },
      logger,
    });
    const report = await service.report();
    expect(report.dependencies.find((d) => d.name === 'state_store')).toMatchObject({
      required: true,
      status: 'down',
    });
    expect(report.status).toBe('not_ready');
  });
});
