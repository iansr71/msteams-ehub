/*
 * Every span and metric the services emit, and the only dimensions and attributes they may
 * carry. Values are checked against these rules when recorded; anything that does not fit is
 * dropped, so a user's email, object ID, question text or a resource URL can never become a
 * metric dimension or a span attribute, even by mistake.
 */

export const SPAN_NAMES = [
  'teams.activity',
  'answer_api.request',
  'api.request',
  'auth.validate',
  'identity.resolve',
  'authorization.courses',
  'moodle.request',
  'moodle.download',
  'pipeline.extract',
  'pipeline.chunk',
  'pipeline.embed',
  'pipeline.index',
  'embedding.request',
  'search.index',
  'search.query',
  'model.generate',
  'citation.validate',
  'sync.job',
  'admin.action',
  'health.check',
] as const;
export type SpanName = (typeof SPAN_NAMES)[number];

/** Codes: lower-case letters, digits, `_` and `.`; no spaces, `@`, `/`, `:` or `-`. */
const CODE = /^[a-z][a-z0-9_.]{0,47}$/;

const ENUMS = {
  service: ['api', 'teams', 'indexer'],
  route: ['health', 'answers', 'feedback', 'admin_api', 'admin_page', 'teams_messages', 'other'],
  outcome: ['success', 'failure'],
  dependency: [
    'moodle',
    'moodle_download',
    'search',
    'embedding',
    'chat',
    'entra_keys',
    'state_store',
    'answer_api',
  ],
  stage: ['download', 'extraction', 'chunking', 'embedding', 'indexing'],
} as const;

type DimensionRule = 'code' | 'status_class' | keyof typeof ENUMS;

/** Dimension keys and how their values are checked. Nothing else is accepted. */
export const DIMENSION_RULES: Readonly<Record<string, DimensionRule>> = {
  service: 'service',
  route: 'route',
  status_class: 'status_class',
  outcome: 'outcome',
  dependency: 'dependency',
  operation: 'code',
  category: 'code',
  stage: 'stage',
  status: 'code',
  kind: 'code',
  reason: 'code',
  method: 'code',
  action: 'code',
  job_type: 'code',
  source: 'code',
};

export function isAllowedDimension(key: string, value: string): boolean {
  const rule = Object.hasOwn(DIMENSION_RULES, key) ? DIMENSION_RULES[key] : undefined;
  if (rule === undefined) {
    return false;
  }
  if (rule === 'code') {
    return CODE.test(value);
  }
  if (rule === 'status_class') {
    return /^[1-5]xx$/.test(value);
  }
  return (ENUMS[rule] as readonly string[]).includes(value);
}

export type MetricKind = 'counter' | 'histogram' | 'gauge';

export interface MetricDefinition {
  readonly kind: MetricKind;
  readonly unit: string;
  readonly description: string;
  readonly dimensions: readonly string[];
}

export const METRICS = {
  'ehub.http.server.duration': {
    kind: 'histogram',
    unit: 'ms',
    description: 'Inbound request duration (API and Teams bot).',
    dimensions: ['service', 'route', 'status_class'],
  },
  'ehub.dependency.duration': {
    kind: 'histogram',
    unit: 'ms',
    description: 'Outbound call duration: Moodle, downloads, search, embeddings, chat model.',
    dimensions: ['dependency', 'operation', 'outcome'],
  },
  'ehub.dependency.failures': {
    kind: 'counter',
    unit: '{failure}',
    description: 'Failed outbound calls, by sanitised category.',
    dimensions: ['dependency', 'operation', 'category'],
  },
  'ehub.pipeline.duration': {
    kind: 'histogram',
    unit: 'ms',
    description: 'Indexing pipeline stage duration per resource.',
    dimensions: ['stage', 'outcome'],
  },
  'ehub.pipeline.failures': {
    kind: 'counter',
    unit: '{failure}',
    description: 'Indexing pipeline failures per resource, by stage and category.',
    dimensions: ['stage', 'category'],
  },
  'ehub.answers': {
    kind: 'counter',
    unit: '{answer}',
    description: 'Answers by outcome (answered, insufficient_evidence, failed).',
    dimensions: ['status'],
  },
  'ehub.citation_validation.failures': {
    kind: 'counter',
    unit: '{failure}',
    description: 'Claims or answers removed or refused by citation validation.',
    dimensions: ['reason'],
  },
  'ehub.access.denials': {
    kind: 'counter',
    unit: '{denial}',
    description: 'Refused requests: authentication, mapping, course access, admin roles.',
    dimensions: ['kind', 'reason'],
  },
  'ehub.auth.events': {
    kind: 'counter',
    unit: '{event}',
    description: 'Token validations by outcome and reason.',
    dimensions: ['outcome', 'reason'],
  },
  'ehub.identity.mappings': {
    kind: 'counter',
    unit: '{mapping}',
    description: 'Moodle identity resolutions by status (mapped, denied) and method or reason.',
    dimensions: ['status', 'method', 'reason'],
  },
  'ehub.rate_limit.events': {
    kind: 'counter',
    unit: '{event}',
    description: 'Throttling: by a dependency, or of a user by the answer API.',
    dimensions: ['dependency'],
  },
  'ehub.sync.jobs': {
    kind: 'counter',
    unit: '{job}',
    description: 'Finished sync jobs by type and status.',
    dimensions: ['job_type', 'status'],
  },
  'ehub.sync.lag': {
    kind: 'gauge',
    unit: 's',
    description: 'Seconds since the last successful sync job finished.',
    dimensions: [],
  },
  'ehub.sync.resources': {
    kind: 'gauge',
    unit: '{resource}',
    description: 'Resources in the sync state by status (removed = stale or deleted).',
    dimensions: ['status'],
  },
  'ehub.admin.actions': {
    kind: 'counter',
    unit: '{action}',
    description: 'Administrative mutations by action and status (accepted, refused, failed).',
    dimensions: ['action', 'status'],
  },
  'ehub.telemetry.dropped': {
    kind: 'counter',
    unit: '{value}',
    description: 'Dimensions or attributes dropped because they broke the rules.',
    dimensions: ['kind'],
  },
} as const satisfies Readonly<Record<string, MetricDefinition>>;
export type MetricName = keyof typeof METRICS;
export type CounterName = {
  [K in MetricName]: (typeof METRICS)[K]['kind'] extends 'counter' ? K : never;
}[MetricName];
export type HistogramName = {
  [K in MetricName]: (typeof METRICS)[K]['kind'] extends 'histogram' ? K : never;
}[MetricName];
export type GaugeName = {
  [K in MetricName]: (typeof METRICS)[K]['kind'] extends 'gauge' ? K : never;
}[MetricName];

export type Dimensions = Readonly<Record<string, string | undefined>>;

/**
 * Keeps only dimensions the metric declares and whose values pass their rule. Returns the
 * kept dimensions and how many were dropped.
 */
export function cleanDimensions(
  metric: MetricName,
  dimensions: Dimensions,
): { readonly kept: Record<string, string>; readonly dropped: number } {
  const declared: readonly string[] = METRICS[metric].dimensions;
  const kept: Record<string, string> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(dimensions)) {
    if (value === undefined) {
      continue;
    }
    if (declared.includes(key) && isAllowedDimension(key, value)) {
      kept[key] = value;
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

// ------------------------------------------------------------------ span attributes

type AttributeRule = 'code' | 'identifier' | 'integer' | 'boolean' | 'http_method';

/**
 * Span attributes. Spans are per request, so identifiers (correlation and job IDs, course IDs)
 * are allowed; names, email addresses, object IDs, URLs and text are not.
 */
export const SPAN_ATTRIBUTE_RULES: Readonly<Record<string, AttributeRule>> = {
  'ehub.correlation_id': 'identifier',
  'ehub.job_id': 'identifier',
  'ehub.answer_id': 'identifier',
  'ehub.course_id': 'integer',
  'ehub.service': 'code',
  'ehub.route': 'code',
  'ehub.outcome': 'code',
  'ehub.category': 'code',
  'ehub.reason': 'code',
  'ehub.status': 'code',
  'ehub.method': 'code',
  'ehub.source': 'code',
  'ehub.stage': 'code',
  'ehub.mode': 'code',
  'ehub.dependency': 'code',
  'ehub.operation': 'code',
  'ehub.action': 'code',
  'ehub.job_type': 'code',
  'ehub.resource_type': 'code',
  'ehub.account_type': 'code',
  'http.request.method': 'http_method',
  'http.response.status_code': 'integer',
  'ehub.count.courses': 'integer',
  'ehub.count.chunks': 'integer',
  'ehub.count.results': 'integer',
  'ehub.count.citations': 'integer',
  'ehub.count.removed_claims': 'integer',
  'ehub.count.bytes': 'integer',
  'ehub.count.inputs': 'integer',
  'ehub.count.attempts': 'integer',
  'ehub.cached': 'boolean',
  'ehub.retryable': 'boolean',
};

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue | undefined>>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isAllowedAttribute(key: string, value: SpanAttributeValue): boolean {
  const rule = Object.hasOwn(SPAN_ATTRIBUTE_RULES, key) ? SPAN_ATTRIBUTE_RULES[key] : undefined;
  switch (rule) {
    case 'code':
      return typeof value === 'string' && CODE.test(value);
    case 'identifier':
      // Correlation and job IDs are UUIDs; they identify a request, not a person. The pattern
      // has no `@`, so an email address never passes.
      return typeof value === 'string' && IDENTIFIER.test(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'boolean':
      return typeof value === 'boolean';
    case 'http_method':
      return typeof value === 'string' && /^[A-Z]{3,7}$/.test(value);
    default:
      return false;
  }
}

export function cleanAttributes(attributes: SpanAttributes): {
  readonly kept: Record<string, SpanAttributeValue>;
  readonly dropped: number;
} {
  const kept: Record<string, SpanAttributeValue> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    if (isAllowedAttribute(key, value)) {
      kept[key] = value;
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}
