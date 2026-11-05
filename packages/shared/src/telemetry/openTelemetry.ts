import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';

import { getCorrelationId } from '../correlation/correlation.js';
import {
  METRICS,
  cleanAttributes,
  cleanDimensions,
  type CounterName,
  type Dimensions,
  type GaugeName,
  type HistogramName,
  type MetricName,
  type SpanName,
} from './catalogue.js';
import type { SpanOptions, Telemetry, TelemetrySpan, TraceHeaders } from './telemetry.js';

const KINDS = {
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  internal: SpanKind.INTERNAL,
} as const;

const CATEGORY = /^[a-z][a-z0-9_.]{0,47}$/;

/**
 * Telemetry through the OpenTelemetry API. With no SDK registered (local development) every
 * call is a no-op inside the API; with Azure Monitor registered (`startTelemetry`) spans become
 * Application Insights requests and dependencies, and metrics become custom metrics.
 *
 * Exceptions are never recorded on spans: error messages can contain URLs, tokens or user
 * input. A span carries only a status and a sanitised category.
 */
export class OpenTelemetryTelemetry implements Telemetry {
  readonly #tracer: Tracer;
  readonly #meter: Meter;
  readonly #instruments = new Map<MetricName, Counter | Histogram | Gauge>();

  constructor(options: { readonly serviceName: string; readonly version: string }) {
    this.#tracer = trace.getTracer(options.serviceName, options.version);
    this.#meter = metrics.getMeter(options.serviceName, options.version);
  }

  #dropped(count: number, kind: 'dimension' | 'attribute'): void {
    if (count > 0) {
      (this.#instrument('ehub.telemetry.dropped') as Counter).add(count, { kind });
    }
  }

  #instrument(metric: MetricName): Counter | Histogram | Gauge {
    const existing = this.#instruments.get(metric);
    if (existing !== undefined) {
      return existing;
    }
    const definition = METRICS[metric];
    const options = { unit: definition.unit, description: definition.description };
    const created =
      definition.kind === 'counter'
        ? this.#meter.createCounter(metric, options)
        : definition.kind === 'histogram'
          ? this.#meter.createHistogram(metric, options)
          : this.#meter.createGauge(metric, options);
    this.#instruments.set(metric, created);
    return created;
  }

  async span<T>(
    name: SpanName,
    fn: (span: TelemetrySpan) => Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const correlationId = getCorrelationId();
    const { kept, dropped } = cleanAttributes({
      ...options.attributes,
      ...(correlationId === undefined ? {} : { 'ehub.correlation_id': correlationId }),
    });
    this.#dropped(dropped, 'attribute');
    return await this.#tracer.startActiveSpan(
      name,
      { kind: KINDS[options.kind ?? 'internal'], attributes: kept },
      async (span) => {
        // Mutable state shared with the handle's closure.
        const state = { failed: false };
        const handle: TelemetrySpan = {
          set: (attributes) => {
            const cleaned = cleanAttributes(attributes);
            this.#dropped(cleaned.dropped, 'attribute');
            span.setAttributes(cleaned.kept);
          },
          fail: (category) => {
            state.failed = true;
            const code = CATEGORY.test(category) ? category : 'error';
            span.setStatus({ code: SpanStatusCode.ERROR, message: code });
            span.setAttribute('ehub.category', code);
          },
        };
        try {
          const result = await fn(handle);
          if (!state.failed) {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return result;
        } catch (error) {
          if (!state.failed) {
            handle.fail(error instanceof Error ? 'exception' : 'error');
          }
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  #record(metric: MetricName, value: number, dimensions: Dimensions): void {
    const { kept, dropped } = cleanDimensions(metric, dimensions);
    this.#dropped(dropped, 'dimension');
    const instrument = this.#instrument(metric);
    const kind = METRICS[metric].kind;
    if (kind === 'counter') {
      (instrument as Counter).add(value, kept);
    } else if (kind === 'histogram') {
      (instrument as Histogram).record(value, kept);
    } else {
      (instrument as Gauge).record(value, kept);
    }
  }

  count(metric: CounterName, dimensions: Dimensions = {}, value = 1): void {
    this.#record(metric, value, dimensions);
  }

  duration(metric: HistogramName, milliseconds: number, dimensions: Dimensions = {}): void {
    this.#record(metric, milliseconds, dimensions);
  }

  gauge(metric: GaugeName, value: number, dimensions: Dimensions = {}): void {
    this.#record(metric, value, dimensions);
  }

  inject(headers: TraceHeaders): void {
    propagation.inject(context.active(), headers);
  }

  withRemoteParent<T>(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    fn: () => T,
  ): T {
    const carrier: Record<string, string> = {};
    for (const name of ['traceparent', 'tracestate']) {
      const value = headers[name];
      if (typeof value === 'string' && value.length <= 512) {
        carrier[name] = value;
      }
    }
    return context.with(propagation.extract(ROOT_CONTEXT, carrier), fn);
  }

  currentTraceId(): string | undefined {
    const spanContext = trace.getActiveSpan()?.spanContext();
    return spanContext === undefined || !trace.isSpanContextValid(spanContext)
      ? undefined
      : spanContext.traceId;
  }
}
