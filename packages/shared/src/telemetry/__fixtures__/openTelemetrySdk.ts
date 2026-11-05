import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

/** Collects on demand: the SDK's own reader, without an export interval. */
class OnDemandReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface TestOpenTelemetrySdk {
  readonly spans: () => ReadableSpan[];
  readonly collect: () => Promise<ResourceMetrics>;
  readonly reset: () => void;
  readonly uninstall: () => void;
}

/**
 * Registers the real OpenTelemetry SDK globally (tracing, metrics, async context and W3C
 * propagation), with in-memory export, so tests see exactly what an exporter would receive.
 */
export function installTestOpenTelemetrySdk(): TestOpenTelemetrySdk {
  const exporter = new InMemorySpanExporter();
  const reader = new OnDemandReader();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  return {
    spans: () => exporter.getFinishedSpans(),
    collect: async () => {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length > 0) {
        throw new Error('Metric collection failed.');
      }
      return resourceMetrics;
    },
    reset: () => {
      exporter.reset();
    },
    uninstall: () => {
      trace.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
    },
  };
}

/** Everything an exporter would send for a span, as text: for "never contains" checks. */
export function exportedSpanText(spans: readonly ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      kind: span.kind,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
      links: span.links,
      resource: span.resource.attributes,
      scope: span.instrumentationScope,
    })),
  );
}

export function exportedMetricText(resource: ResourceMetrics): string {
  return JSON.stringify({ resource: resource.resource.attributes, scopes: resource.scopeMetrics });
}
