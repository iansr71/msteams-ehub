import type { ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runWithCorrelationId } from '../correlation/correlation.js';
import {
  installTestOpenTelemetrySdk,
  type TestOpenTelemetrySdk,
} from './__fixtures__/openTelemetrySdk.js';
import { OpenTelemetryTelemetry } from './openTelemetry.js';

let sdk: TestOpenTelemetrySdk;
let telemetry: OpenTelemetryTelemetry;

beforeAll(() => {
  sdk = installTestOpenTelemetrySdk();
  telemetry = new OpenTelemetryTelemetry({ serviceName: 'ehub-test', version: '0.0.0' });
});

afterAll(() => {
  sdk.uninstall();
});

beforeEach(() => {
  sdk.reset();
});

function collected(): Promise<ResourceMetrics> {
  return sdk.collect();
}

function points(
  resource: ResourceMetrics,
  name: string,
): { attributes: unknown; value: unknown }[] {
  return resource.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) =>
      metric.dataPoints.map((point) => ({ attributes: point.attributes, value: point.value })),
    );
}

describe('OpenTelemetryTelemetry with the OpenTelemetry SDK', () => {
  it('exports a span with cleaned attributes and the correlation ID', async () => {
    await runWithCorrelationId('corr-0001', () =>
      telemetry.span(
        'search.query',
        async (span) => {
          span.set({ 'ehub.count.results': 4, 'url.full': 'https://x/?token=t' });
          await Promise.resolve();
        },
        {
          kind: 'client',
          attributes: { 'ehub.dependency': 'search', 'user.email': 'a@example.com' },
        },
      ),
    );
    const [span] = sdk.spans();
    expect(span?.name).toBe('search.query');
    expect(span?.kind).toBe(2); // CLIENT
    expect(span?.attributes).toEqual({
      'ehub.dependency': 'search',
      'ehub.correlation_id': 'corr-0001',
      'ehub.count.results': 4,
    });
    expect(span?.status.code).toBe(1); // OK
  });

  it('records a failure as status and category only: no exception event or message', async () => {
    const error = new Error('POST https://ehub.example.com/?wstoken=abc123 returned 500');
    await expect(
      telemetry.span('moodle.request', (span) => {
        span.fail('server_error');
        return Promise.reject(error);
      }),
    ).rejects.toBe(error);
    await expect(
      telemetry.span('model.generate', () => Promise.reject(new Error('Bearer eyJabc'))),
    ).rejects.toThrow();
    await telemetry.span('search.query', (span) => {
      span.fail('Bad Request: https://x/?key=k');
      return Promise.resolve();
    });
    const [moodle, model, unsafe] = sdk.spans();
    expect(unsafe?.status).toEqual({ code: 2, message: 'error' });
    expect(unsafe?.attributes['ehub.category']).toBe('error');
    expect(moodle?.status).toEqual({ code: 2, message: 'server_error' });
    expect(moodle?.attributes['ehub.category']).toBe('server_error');
    expect(model?.status).toEqual({ code: 2, message: 'exception' });
    for (const span of [moodle, model]) {
      expect(span?.events).toEqual([]);
    }
    const serialised = JSON.stringify(sdk.spans().map((s) => [s.attributes, s.status]));
    expect(serialised).not.toMatch(/abc123|eyJ|https/);
  });

  it('nests spans and reports the active trace ID', async () => {
    let traceId: string | undefined;
    await telemetry.span('api.request', () =>
      telemetry.span('search.query', () => {
        traceId = telemetry.currentTraceId();
        return Promise.resolve();
      }),
    );
    const [inner, outer] = sdk.spans();
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(traceId).toBe(outer?.spanContext().traceId);
    expect(telemetry.currentTraceId()).toBeUndefined();
  });

  it('propagates W3C trace context from the bot to the API', async () => {
    const headers: Record<string, string> = {};
    await telemetry.span('answer_api.request', () => {
      telemetry.inject(headers);
      return Promise.resolve();
    });
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    await telemetry.withRemoteParent({ traceparent: headers['traceparent'] }, () =>
      telemetry.span('api.request', () => Promise.resolve(), { kind: 'server' }),
    );
    const [client, server] = sdk.spans();
    expect(server?.spanContext().traceId).toBe(client?.spanContext().traceId);
    expect(server?.parentSpanContext?.spanId).toBe(client?.spanContext().spanId);
  });

  it('ignores an oversized or malformed traceparent', async () => {
    await telemetry.withRemoteParent({ traceparent: `00-${'a'.repeat(600)}` }, () =>
      telemetry.span('api.request', () => Promise.resolve()),
    );
    await telemetry.withRemoteParent({ traceparent: ['a', 'b'] }, () =>
      telemetry.span('api.request', () => Promise.resolve()),
    );
    for (const span of sdk.spans()) {
      expect(span.parentSpanContext).toBeUndefined();
    }
  });

  it('exports metrics with only allowed dimensions and counts the dropped ones', async () => {
    telemetry.count('ehub.answers', { status: 'answered', userId: 'thandi@example.com' });
    telemetry.duration('ehub.dependency.duration', 12.5, {
      dependency: 'chat',
      operation: 'complete',
      outcome: 'success',
    });
    telemetry.gauge('ehub.sync.lag', 300);
    const resource = await collected();
    expect(points(resource, 'ehub.answers')).toEqual([
      { attributes: { status: 'answered' }, value: 1 },
    ]);
    expect(points(resource, 'ehub.dependency.duration')[0]?.attributes).toEqual({
      dependency: 'chat',
      operation: 'complete',
      outcome: 'success',
    });
    expect(points(resource, 'ehub.sync.lag')).toEqual([{ attributes: {}, value: 300 }]);
    // Cumulative across this file: the first test dropped two span attributes.
    expect(points(resource, 'ehub.telemetry.dropped')).toEqual(
      expect.arrayContaining([
        { attributes: { kind: 'dimension' }, value: 1 },
        { attributes: { kind: 'attribute' }, value: 2 },
      ]),
    );
    expect(JSON.stringify(resource.scopeMetrics)).not.toContain('example.com');
  });
});
