import {
  cleanAttributes,
  cleanDimensions,
  type CounterName,
  type Dimensions,
  type GaugeName,
  type HistogramName,
  type MetricName,
  type SpanAttributes,
  type SpanName,
} from './catalogue.js';

/** Carries W3C trace context (`traceparent`, `tracestate`) across HTTP calls. */
export type TraceHeaders = Record<string, string>;

export interface TelemetrySpan {
  /** Adds attributes; values that break the catalogue's rules are dropped. */
  set(attributes: SpanAttributes): void;
  /** Marks the span failed with a sanitised category code (never an error message). */
  fail(category: string): void;
}

export interface SpanOptions {
  readonly attributes?: SpanAttributes;
  /** `server` for inbound requests, `client` for outbound calls, `internal` otherwise. */
  readonly kind?: 'server' | 'client' | 'internal';
}

/**
 * The services' view of tracing and metrics. OpenTelemetry-compatible: the production
 * implementation (`OpenTelemetryTelemetry`) uses @opentelemetry/api, which Azure Monitor's
 * distribution plugs into. Every name comes from the catalogue; every dimension and attribute
 * is checked against it.
 */
export interface Telemetry {
  span<T>(
    name: SpanName,
    fn: (span: TelemetrySpan) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
  count(metric: CounterName, dimensions?: Dimensions, value?: number): void;
  duration(metric: HistogramName, milliseconds: number, dimensions?: Dimensions): void;
  gauge(metric: GaugeName, value: number, dimensions?: Dimensions): void;
  /** Adds the active trace context to outgoing headers. */
  inject(headers: TraceHeaders): void;
  /** Runs `fn` with the trace context of an incoming request as the parent. */
  withRemoteParent<T>(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    fn: () => T,
  ): T;
  /** The active trace ID, for log correlation; undefined without a tracing backend. */
  currentTraceId(): string | undefined;
}

const NOOP_SPAN: TelemetrySpan = {
  set: () => undefined,
  fail: () => undefined,
};

export const noopTelemetry: Telemetry = {
  span: (_name, fn) => fn(NOOP_SPAN),
  count: () => undefined,
  duration: () => undefined,
  gauge: () => undefined,
  inject: () => undefined,
  withRemoteParent: (_headers, fn) => fn(),
  currentTraceId: () => undefined,
};

/*
 * Telemetry is reached through a process-wide registry, like OpenTelemetry's own global API:
 * it is configured once at start-up (`startTelemetry`) and every component uses the same one.
 * Threading it through every constructor would change dozens of established interfaces for a
 * cross-cutting concern. Tests swap in `InMemoryTelemetry`.
 */
let current: Telemetry = noopTelemetry;

export function getTelemetry(): Telemetry {
  return current;
}

export function setTelemetry(telemetry: Telemetry): void {
  current = telemetry;
}

export function resetTelemetry(): void {
  current = noopTelemetry;
}

export interface RecordedSpan {
  readonly name: SpanName;
  readonly kind: 'server' | 'client' | 'internal';
  readonly attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  failureCategory: string | undefined;
  readonly parent: RecordedSpan | undefined;
}

export interface RecordedMetric {
  readonly metric: MetricName;
  readonly value: number;
  readonly dimensions: Record<string, string>;
}

/** Records everything in memory, applying the same rules as production. For tests. */
export class InMemoryTelemetry implements Telemetry {
  readonly spans: RecordedSpan[] = [];
  readonly metrics: RecordedMetric[] = [];
  dropped = 0;
  #stack: RecordedSpan[] = [];
  injected = 0;
  remoteParents: string[] = [];

  async span<T>(
    name: SpanName,
    fn: (span: TelemetrySpan) => Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const { kept, dropped } = cleanAttributes(options.attributes ?? {});
    this.dropped += dropped;
    const record: RecordedSpan = {
      name,
      kind: options.kind ?? 'internal',
      attributes: kept,
      status: 'ok',
      failureCategory: undefined,
      parent: this.#stack.at(-1),
    };
    this.spans.push(record);
    const handle: TelemetrySpan = {
      set: (attributes) => {
        const cleaned = cleanAttributes(attributes);
        this.dropped += cleaned.dropped;
        Object.assign(record.attributes, cleaned.kept);
      },
      fail: (category) => {
        record.status = 'error';
        record.failureCategory = /^[a-z][a-z0-9_.]{0,47}$/.test(category) ? category : 'error';
      },
    };
    // A simple stack is enough for the sequential code paths tests exercise.
    this.#stack.push(record);
    try {
      return await fn(handle);
    } catch (error) {
      if (record.status === 'ok') {
        handle.fail('exception');
      }
      throw error;
    } finally {
      this.#stack = this.#stack.filter((entry) => entry !== record);
    }
  }

  #metric(metric: MetricName, value: number, dimensions: Dimensions): void {
    const { kept, dropped } = cleanDimensions(metric, dimensions);
    this.dropped += dropped;
    this.metrics.push({ metric, value, dimensions: kept });
  }

  count(metric: CounterName, dimensions: Dimensions = {}, value = 1): void {
    this.#metric(metric, value, dimensions);
  }

  duration(metric: HistogramName, milliseconds: number, dimensions: Dimensions = {}): void {
    this.#metric(metric, milliseconds, dimensions);
  }

  gauge(metric: GaugeName, value: number, dimensions: Dimensions = {}): void {
    this.#metric(metric, value, dimensions);
  }

  inject(headers: TraceHeaders): void {
    this.injected += 1;
    headers['traceparent'] = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  }

  withRemoteParent<T>(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    fn: () => T,
  ): T {
    const parent = headers['traceparent'];
    if (typeof parent === 'string') {
      this.remoteParents.push(parent);
    }
    return fn();
  }

  currentTraceId(): string | undefined {
    return this.#stack.length > 0 ? '0af7651916cd43dd8448eb211c80319c' : undefined;
  }

  /** Metrics with this name (and, optionally, matching dimensions). */
  find(metric: MetricName, dimensions: Readonly<Record<string, string>> = {}): RecordedMetric[] {
    return this.metrics.filter(
      (entry) =>
        entry.metric === metric &&
        Object.entries(dimensions).every(([key, value]) => entry.dimensions[key] === value),
    );
  }

  sum(metric: MetricName, dimensions: Readonly<Record<string, string>> = {}): number {
    return this.find(metric, dimensions).reduce((total, entry) => total + entry.value, 0);
  }
}

export type DependencyName =
  | 'moodle'
  | 'moodle_download'
  | 'search'
  | 'embedding'
  | 'chat'
  | 'entra_keys'
  | 'state_store'
  | 'answer_api';

export interface DependencyFailure {
  /** Sanitised category code, e.g. `timeout`, `rate_limit`, `authentication`. */
  readonly category: string;
  readonly rateLimited: boolean;
}

/**
 * Wraps one outbound call: a client span, its duration, and on failure a failure count (and a
 * rate-limit event when the dependency throttled). `classify` turns the error into codes; the
 * error itself is never recorded.
 */
export async function trackDependency<T>(
  options: {
    readonly span: SpanName;
    readonly dependency: DependencyName;
    readonly operation: string;
    readonly attributes?: SpanAttributes;
    readonly classify: (error: unknown) => DependencyFailure;
  },
  fn: (span: TelemetrySpan) => Promise<T>,
): Promise<T> {
  const telemetry = getTelemetry();
  const started = performance.now();
  return await telemetry.span(
    options.span,
    async (span) => {
      try {
        const result = await fn(span);
        telemetry.duration('ehub.dependency.duration', performance.now() - started, {
          dependency: options.dependency,
          operation: options.operation,
          outcome: 'success',
        });
        return result;
      } catch (error) {
        const failure = options.classify(error);
        span.fail(failure.category);
        telemetry.duration('ehub.dependency.duration', performance.now() - started, {
          dependency: options.dependency,
          operation: options.operation,
          outcome: 'failure',
        });
        telemetry.count('ehub.dependency.failures', {
          dependency: options.dependency,
          operation: options.operation,
          category: failure.category,
        });
        if (failure.rateLimited) {
          telemetry.count('ehub.rate_limit.events', { dependency: options.dependency });
        }
        throw error;
      }
    },
    {
      kind: 'client',
      attributes: {
        'ehub.dependency': options.dependency,
        'ehub.operation': options.operation,
        ...options.attributes,
      },
    },
  );
}

/** Wraps one indexing pipeline stage for one resource. */
export async function trackStage<T>(
  stage: 'download' | 'extraction' | 'chunking' | 'embedding' | 'indexing',
  span: SpanName,
  fn: (span: TelemetrySpan) => Promise<T>,
  classify: (error: unknown) => string,
): Promise<T> {
  const telemetry = getTelemetry();
  const started = performance.now();
  return await telemetry.span(
    span,
    async (handle) => {
      try {
        const result = await fn(handle);
        telemetry.duration('ehub.pipeline.duration', performance.now() - started, {
          stage,
          outcome: 'success',
        });
        return result;
      } catch (error) {
        const category = classify(error);
        handle.fail(category);
        telemetry.duration('ehub.pipeline.duration', performance.now() - started, {
          stage,
          outcome: 'failure',
        });
        telemetry.count('ehub.pipeline.failures', { stage, category });
        throw error;
      }
    },
    { attributes: { 'ehub.stage': stage } },
  );
}

/** `2xx`…`5xx` for the status-class dimension. */
export function statusClass(status: number): string {
  return `${String(Math.min(5, Math.max(1, Math.floor(status / 100))))}xx`;
}

/** A code-safe form of an arbitrary label (lower-cased, unsafe characters replaced). */
export function toCode(value: string | undefined, fallback = 'unknown'): string {
  if (value === undefined) {
    return fallback;
  }
  const code = value
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 48);
  return code === '' ? fallback : code;
}

/**
 * Telemetry codes from an error with a `category` field (the search, embedding, chat and
 * Moodle clients' errors). Anything else is `unexpected`; the message is never read.
 */
export function classifyByCategory(error: unknown): DependencyFailure {
  const category =
    typeof error === 'object' && error !== null && 'category' in error ? error.category : undefined;
  if (typeof category !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(category)) {
    return { category: 'unexpected', rateLimited: false };
  }
  return { category, rateLimited: category === 'throttled' || category === 'rate_limit' };
}
