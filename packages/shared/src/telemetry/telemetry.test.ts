import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryTelemetry,
  classifyByCategory,
  getTelemetry,
  noopTelemetry,
  resetTelemetry,
  setTelemetry,
  statusClass,
  toCode,
  trackDependency,
  trackStage,
} from './telemetry.js';

afterEach(() => {
  resetTelemetry();
});

function categorised(category: string): Error {
  return Object.assign(new Error('GET https://ehub.example.com/?token=secret failed'), {
    category,
  });
}

describe('telemetry registry', () => {
  it('defaults to the no-op implementation and can be swapped', async () => {
    expect(getTelemetry()).toBe(noopTelemetry);
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    expect(getTelemetry()).toBe(memory);
    resetTelemetry();
    expect(getTelemetry()).toBe(noopTelemetry);
    await expect(noopTelemetry.span('api.request', () => Promise.resolve(7))).resolves.toBe(7);
    expect(noopTelemetry.withRemoteParent({}, () => 'x')).toBe('x');
    expect(noopTelemetry.currentTraceId()).toBeUndefined();
  });
});

describe('InMemoryTelemetry', () => {
  it('records nested spans with cleaned attributes', async () => {
    const memory = new InMemoryTelemetry();
    await memory.span(
      'api.request',
      async (span) => {
        span.set({ 'ehub.route': 'answers', 'user.email': 'a@example.com' });
        await memory.span('search.query', () => Promise.resolve());
      },
      { kind: 'server', attributes: { 'ehub.service': 'api' } },
    );
    const [outer, inner] = memory.spans;
    expect(outer).toMatchObject({
      name: 'api.request',
      kind: 'server',
      attributes: { 'ehub.service': 'api', 'ehub.route': 'answers' },
      status: 'ok',
    });
    expect(inner?.parent).toBe(outer);
    expect(memory.dropped).toBe(1);
  });

  it('marks a span failed on exception without recording the error', async () => {
    const memory = new InMemoryTelemetry();
    await expect(
      memory.span('model.generate', () => Promise.reject(new Error('secret text'))),
    ).rejects.toThrow('secret text');
    expect(memory.spans[0]).toMatchObject({ status: 'error', failureCategory: 'exception' });
    expect(JSON.stringify(memory.spans[0]?.attributes)).not.toContain('secret');
  });

  it('replaces an unsafe failure category', async () => {
    const memory = new InMemoryTelemetry();
    await memory.span('model.generate', (span) => {
      span.fail('Bad Request: https://x');
      return Promise.resolve();
    });
    expect(memory.spans[0]?.failureCategory).toBe('error');
  });
});

describe('trackDependency', () => {
  it('records a client span and a success duration', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const result = await trackDependency(
      {
        span: 'moodle.request',
        dependency: 'moodle',
        operation: 'core_webservice_get_site_info',
        classify: classifyByCategory,
      },
      () => Promise.resolve('ok'),
    );
    expect(result).toBe('ok');
    expect(memory.spans[0]).toMatchObject({
      name: 'moodle.request',
      kind: 'client',
      attributes: {
        'ehub.dependency': 'moodle',
        'ehub.operation': 'core_webservice_get_site_info',
      },
    });
    expect(memory.find('ehub.dependency.duration')).toEqual([
      expect.objectContaining({
        dimensions: {
          dependency: 'moodle',
          operation: 'core_webservice_get_site_info',
          outcome: 'success',
        },
      }),
    ]);
    expect(memory.find('ehub.dependency.failures')).toEqual([]);
  });

  it('counts a failure by category and rethrows the original error', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    const error = categorised('timeout');
    await expect(
      trackDependency(
        {
          span: 'search.query',
          dependency: 'search',
          operation: 'query',
          classify: classifyByCategory,
        },
        () => Promise.reject(error),
      ),
    ).rejects.toBe(error);
    expect(memory.spans[0]).toMatchObject({ status: 'error', failureCategory: 'timeout' });
    expect(memory.sum('ehub.dependency.failures', { category: 'timeout' })).toBe(1);
    expect(memory.find('ehub.dependency.duration', { outcome: 'failure' })).toHaveLength(1);
    expect(memory.find('ehub.rate_limit.events')).toEqual([]);
    expect(JSON.stringify(memory.metrics)).not.toContain('token');
  });

  it.each(['throttled', 'rate_limit'])('counts a rate-limit event for %s', async (category) => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    await expect(
      trackDependency(
        {
          span: 'embedding.request',
          dependency: 'embedding',
          operation: 'embed',
          classify: classifyByCategory,
        },
        () => Promise.reject(categorised(category)),
      ),
    ).rejects.toThrow();
    expect(memory.find('ehub.rate_limit.events', { dependency: 'embedding' })).toHaveLength(1);
  });
});

describe('trackStage', () => {
  it('records stage duration on success and a stage failure on error', async () => {
    const memory = new InMemoryTelemetry();
    setTelemetry(memory);
    await trackStage(
      'chunking',
      'pipeline.chunk',
      () => Promise.resolve(),
      () => 'x',
    );
    await expect(
      trackStage(
        'indexing',
        'search.index',
        () => Promise.reject(new Error('e')),
        () => 'search_unavailable',
      ),
    ).rejects.toThrow();
    expect(
      memory.find('ehub.pipeline.duration', { stage: 'chunking', outcome: 'success' }),
    ).toHaveLength(1);
    expect(
      memory.find('ehub.pipeline.duration', { stage: 'indexing', outcome: 'failure' }),
    ).toHaveLength(1);
    expect(memory.find('ehub.pipeline.failures')).toEqual([
      expect.objectContaining({
        dimensions: { stage: 'indexing', category: 'search_unavailable' },
      }),
    ]);
    expect(memory.spans.map((span) => span.attributes['ehub.stage'])).toEqual([
      'chunking',
      'indexing',
    ]);
  });
});

describe('helpers', () => {
  it('maps statuses to classes', () => {
    expect([200, 204, 301, 404, 429, 500, 503, 99, 700].map(statusClass)).toEqual([
      '2xx',
      '2xx',
      '3xx',
      '4xx',
      '4xx',
      '5xx',
      '5xx',
      '1xx',
      '5xx',
    ]);
  });

  it('turns labels into codes', () => {
    expect(toCode('admin:sync-run')).toBe('admin_sync_run');
    expect(toCode('Full-Sync')).toBe('full_sync');
    expect(toCode('9lives')).toBe('lives');
    expect(toCode('123')).toBe('unknown');
    expect(toCode(undefined, 'none')).toBe('none');
    expect(toCode('x'.repeat(60))).toHaveLength(48);
  });

  it('classifies only well-formed categories and never reads the message', () => {
    expect(classifyByCategory(categorised('authentication'))).toEqual({
      category: 'authentication',
      rateLimited: false,
    });
    expect(classifyByCategory(new Error('timeout'))).toEqual({
      category: 'unexpected',
      rateLimited: false,
    });
    expect(classifyByCategory(categorised('has spaces'))).toEqual({
      category: 'unexpected',
      rateLimited: false,
    });
    expect(classifyByCategory({ category: 42 })).toEqual({
      category: 'unexpected',
      rateLimited: false,
    });
    expect(classifyByCategory(null)).toEqual({ category: 'unexpected', rateLimited: false });
  });
});
