export const REDACTED = '[REDACTED]';

/**
 * Keys whose values are always replaced. Matching is case-insensitive and ignores
 * separators, so `MOODLE_TOKEN`, `moodleToken` and `moodle-token` all match.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'apiKey',
  'MOODLE_TOKEN',
];

/**
 * A key is also sensitive when its normalised form ends with one of these suffixes,
 * e.g. `wstoken`, `idToken`, `x-api-key`, `proxy-authorization`, `AZURE_CLIENT_SECRET`.
 * Suffix matching deliberately leaves counters such as `tokenCount` or `maxTokens` visible.
 */
const SENSITIVE_KEY_SUFFIXES: readonly string[] = [
  'token',
  'secret',
  'password',
  'apikey',
  'authorization',
  'cookie',
  'connectionstring',
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const NORMALIZED_SENSITIVE_KEYS = new Set(SENSITIVE_KEYS.map(normalizeKey));

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (NORMALIZED_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const STRING_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Credentials carried in URL query strings (Moodle uses ?wstoken= / &token= on file URLs).
  [
    /([?&;](?:wstoken|token|access_token|refresh_token|id_token|api[-_]?key|client_secret|code|sig|password)=)[^&#\s"'<>]*/gi,
    `$1${REDACTED}`,
  ],
  // Authorization header values embedded in free text.
  [/\b(Bearer|Basic|Negotiate)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${REDACTED}`],
  // JWTs (header.payload.signature, base64url, header always starts with eyJ).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Application Insights / storage style connection-string secrets.
  [
    /((?:InstrumentationKey|AccountKey|SharedAccessSignature|SharedAccessKey)=)[^;\s"']+/gi,
    `$1${REDACTED}`,
  ],
];

const MIN_REGISTERED_SECRET_LENGTH = 6;
const registeredSecrets = new Set<string>();

/**
 * Registers a concrete secret value (for example the loaded Moodle token) so that it is
 * scrubbed wherever it appears in log output, even inside unrelated strings or keys.
 */
export function registerSecretValue(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length >= MIN_REGISTERED_SECRET_LENGTH) {
    registeredSecrets.add(trimmed);
  }
}

/** Test support: removes every registered secret value. */
export function clearRegisteredSecretValues(): void {
  registeredSecrets.clear();
}

export function redactString(input: string): string {
  let output = input;
  // Longest first so a secret that contains another secret is removed whole.
  const secrets = [...registeredSecrets].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }
  for (const [pattern, replacement] of STRING_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export interface RedactOptions {
  /** Maximum object nesting depth retained in output. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;

/**
 * Returns a JSON-safe deep copy of `value` with sensitive keys masked, secrets scrubbed from
 * strings and binary payloads summarised (so document bytes never reach logs).
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  return redactInner(value, 0, maxDepth, new WeakSet<object>());
}

function redactInner(
  value: unknown,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): unknown {
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
      return undefined;
    case 'symbol':
      return value.toString();
    case 'function':
      return '[Function]';
    case 'object':
      break;
  }

  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof URL) {
    return redactString(value.href);
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[Binary ${String(value.byteLength)} bytes]`;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (depth >= maxDepth) {
    return '[MaxDepth]';
  }
  seen.add(value);

  try {
    if (value instanceof Error) {
      return redactError(value, depth, maxDepth, seen);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactInner(item, depth + 1, maxDepth, seen));
    }
    if (value instanceof Map) {
      return redactEntries(value.entries(), depth, maxDepth, seen);
    }
    if (value instanceof Set) {
      return [...value].map((item: unknown) => redactInner(item, depth + 1, maxDepth, seen));
    }
    if (isHeadersLike(value)) {
      return redactEntries(value.entries(), depth, maxDepth, seen);
    }
    return redactEntries(Object.entries(value), depth, maxDepth, seen);
  } finally {
    seen.delete(value);
  }
}

function redactEntries(
  entries: Iterable<[unknown, unknown]>,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [rawKey, entryValue] of entries) {
    const key = redactString(String(rawKey));
    output[key] = isSensitiveKey(String(rawKey))
      ? REDACTED
      : redactInner(entryValue, depth + 1, maxDepth, seen);
  }
  return output;
}

function redactError(
  error: Error,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: redactString(error.name),
    message: redactString(error.message),
  };
  if (error.stack !== undefined) {
    output['stack'] = redactString(error.stack);
  }
  // Copy enumerable own properties (e.g. `code`, `status`) through the same key rules.
  Object.assign(output, redactEntries(Object.entries(error), depth, maxDepth, seen));
  if (error.cause !== undefined) {
    output['cause'] = redactInner(error.cause, depth + 1, maxDepth, seen);
  }
  return output;
}

interface HeadersLike {
  entries(): IterableIterator<[string, string]>;
  get(name: string): string | null;
  has(name: string): boolean;
}

function isHeadersLike(value: object): value is HeadersLike {
  return typeof Headers !== 'undefined' && value instanceof Headers;
}
