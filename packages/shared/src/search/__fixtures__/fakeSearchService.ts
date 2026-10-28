/*
 * An in-memory imitation of the Azure AI Search REST endpoints the client uses, for unit tests
 * (as a fetch function) and integration tests (behind a local HTTPS server). It implements only
 * the filter shapes the client generates, and enforces the rules that matter to the client:
 * authentication, conditional index writes, Azure's in-place index update restrictions,
 * per-document results and the 1000-document batch limit.
 */

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

type Json = Record<string, unknown>;

interface StoredIndex {
  definition: Json;
  etag: number;
}

export interface FakeSearchServiceOptions {
  readonly apiKey?: string;
  readonly bearerToken?: string;
}

const FIELD_DEFAULTS = {
  key: false,
  searchable: false,
  filterable: false,
  sortable: false,
  facetable: false,
  retrievable: true,
  stored: true,
  analyzer: null,
  searchAnalyzer: null,
  indexAnalyzer: null,
  normalizer: null,
  dimensions: null,
  vectorSearchProfile: null,
  vectorEncoding: null,
  synonymMaps: [],
} as const;

const IMMUTABLE_FIELD_ATTRIBUTES = [
  'type',
  'key',
  'searchable',
  'filterable',
  'sortable',
  'facetable',
  'stored',
  'analyzer',
  'dimensions',
  'vectorSearchProfile',
] as const;

function json(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  };
}

function errorResponse(status: number, code: string, message: string): FakeResponse {
  return json(status, { error: { code, message } });
}

function unquote(literal: string): string {
  return literal.replaceAll("''", "'");
}

const QUOTED = "'((?:[^']|'')*)'";

/** Evaluates the subset of OData filters the client produces. */
export function matchesFilter(document: Json, filter: string | undefined): boolean {
  if (filter === undefined || filter === '') {
    return true;
  }
  const checks: ((doc: Json) => boolean)[] = [];
  const tenant = new RegExp(`tenantId eq ${QUOTED}`).exec(filter);
  if (tenant?.[1] !== undefined) {
    const value = unquote(tenant[1]);
    checks.push((doc) => doc['tenantId'] === value);
  }
  const resource = new RegExp(`resourceId eq ${QUOTED}`).exec(filter);
  if (resource?.[1] !== undefined) {
    const value = unquote(resource[1]);
    checks.push((doc) => doc['resourceId'] === value);
  }
  const after = new RegExp(`id gt ${QUOTED}`).exec(filter);
  if (after?.[1] !== undefined) {
    const value = unquote(after[1]);
    checks.push((doc) => String(doc['id']) > value);
  }
  const courses = [...filter.matchAll(/courseId eq (\d+)/g)].map((match) => Number(match[1]));
  if (courses.length > 0) {
    checks.push((doc) => courses.includes(Number(doc['courseId'])));
  }
  if (filter.includes('isActive eq true')) {
    checks.push((doc) => doc['isActive'] === true);
  }
  const principals: ((doc: Json) => boolean)[] = [];
  for (const field of ['allowedUserIds', 'allowedGroupIds']) {
    const match = new RegExp(`${field}/any\\(v: search\\.in\\(v, ${QUOTED}, ','\\)\\)`).exec(
      filter,
    );
    if (match?.[1] !== undefined) {
      const allowed = new Set(unquote(match[1]).split(','));
      principals.push((doc) => {
        const values = doc[field];
        return Array.isArray(values) && values.some((value) => allowed.has(String(value)));
      });
    }
  }
  if (principals.length > 0) {
    checks.push((doc) => principals.some((check) => check(doc)));
  }
  return checks.every((check) => check(document));
}

export class FakeSearchService {
  readonly indexes = new Map<string, StoredIndex>();
  readonly documents = new Map<string, Map<string, Json>>();
  readonly requests: FakeRequest[] = [];
  /** Responses returned instead of normal handling, consumed in order. */
  readonly scriptedResponses: FakeResponse[] = [];
  /** Per-document status codes to report (consumed one per indexing attempt). */
  readonly documentFailures = new Map<string, number[]>();
  serviceStatsStatus = 200;
  readonly #options: FakeSearchServiceOptions;

  constructor(options: FakeSearchServiceOptions = {}) {
    this.#options = options;
  }

  /** Adapter for code that takes a fetch function. */
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const response = this.handle({
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    });
    return Promise.resolve(
      new Response(response.status === 204 ? null : (response.body ?? ''), {
        status: response.status,
        headers: response.headers ?? {},
      }),
    );
  };

  handle(request: FakeRequest): FakeResponse {
    this.requests.push(request);
    const scripted = this.scriptedResponses.shift();
    if (scripted !== undefined) {
      return scripted;
    }
    if (!this.#authorized(request.headers)) {
      return errorResponse(401, 'Unauthorized', 'Access denied.');
    }
    if (request.query.get('api-version') !== '2026-04-01') {
      return errorResponse(400, 'InvalidApiVersion', 'Unsupported api-version.');
    }
    if (request.method === 'GET' && request.path === '/servicestats') {
      if (this.serviceStatsStatus !== 200) {
        return errorResponse(this.serviceStatsStatus, 'Forbidden', 'Forbidden.');
      }
      return json(200, {
        counters: {
          documentCount: { usage: this.#documentTotal(), quota: null },
          indexesCount: { usage: this.indexes.size, quota: 15 },
          storageSize: { usage: 1024, quota: 2147483648 },
        },
        limits: {},
      });
    }
    const match = /^\/indexes\/([^/]+)(\/.*)?$/.exec(request.path);
    if (match?.[1] === undefined) {
      return errorResponse(404, 'NotFound', 'No such resource.');
    }
    const name = decodeURIComponent(match[1]);
    const rest = match[2] ?? '';
    if (rest === '' && request.method === 'GET') {
      return this.#getIndex(name);
    }
    if (rest === '' && request.method === 'PUT') {
      return this.#putIndex(name, request);
    }
    const stored = this.indexes.get(name);
    if (stored === undefined) {
      return errorResponse(404, 'IndexNotFound', `The index '${name}' was not found.`);
    }
    if (rest === '/stats' && request.method === 'GET') {
      return json(200, {
        documentCount: this.documents.get(name)?.size ?? 0,
        storageSize: 2048,
        vectorIndexSize: 512,
      });
    }
    if (rest === '/docs/index' && request.method === 'POST') {
      return this.#indexDocuments(name, request.body);
    }
    if (rest === '/docs/search' && request.method === 'POST') {
      return this.#search(name, stored, request.body);
    }
    return errorResponse(404, 'NotFound', 'No such resource.');
  }

  /** Test support: puts documents straight into an index. */
  seed(indexName: string, documents: readonly Json[]): void {
    const store = this.documents.get(indexName) ?? new Map<string, Json>();
    for (const document of documents) {
      store.set(String(document['id']), { ...document });
    }
    this.documents.set(indexName, store);
  }

  #documentTotal(): number {
    let total = 0;
    for (const store of this.documents.values()) {
      total += store.size;
    }
    return total;
  }

  #authorized(headers: Readonly<Record<string, string>>): boolean {
    if (this.#options.apiKey !== undefined && headers['api-key'] === this.#options.apiKey) {
      return true;
    }
    return (
      this.#options.bearerToken !== undefined &&
      headers['authorization'] === `Bearer ${this.#options.bearerToken}`
    );
  }

  #getIndex(name: string): FakeResponse {
    const stored = this.indexes.get(name);
    if (stored === undefined) {
      return errorResponse(404, 'IndexNotFound', `The index '${name}' was not found.`);
    }
    const etag = `"0x${stored.etag.toString(16)}"`;
    return json(200, { '@odata.etag': etag, ...stored.definition }, { etag });
  }

  #putIndex(name: string, request: FakeRequest): FakeResponse {
    const existing = this.indexes.get(name);
    const ifNoneMatch = request.headers['if-none-match'];
    const ifMatch = request.headers['if-match'];
    if (ifNoneMatch === '*' && existing !== undefined) {
      return errorResponse(412, 'PreconditionFailed', 'The index already exists.');
    }
    if (ifMatch !== undefined) {
      if (existing === undefined) {
        return errorResponse(412, 'PreconditionFailed', 'The index does not exist.');
      }
      if (ifMatch !== '*' && ifMatch !== `"0x${existing.etag.toString(16)}"`) {
        return errorResponse(412, 'PreconditionFailed', 'The index has changed.');
      }
    }
    let body: Json;
    try {
      body = JSON.parse(request.body) as Json;
    } catch {
      return errorResponse(400, 'InvalidRequest', 'Malformed JSON.');
    }
    if (body['name'] !== name || !Array.isArray(body['fields'])) {
      return errorResponse(400, 'InvalidRequest', 'Index name or fields missing.');
    }
    const fields = (body['fields'] as Json[]).map((field) => ({ ...FIELD_DEFAULTS, ...field }));
    if (existing !== undefined) {
      const problem = this.#inPlaceProblem(existing.definition, fields);
      if (problem !== undefined) {
        return errorResponse(400, 'OperationNotAllowed', problem);
      }
    }
    for (const property of Object.keys(body)) {
      if (property.startsWith('@odata.')) {
        return errorResponse(400, 'InvalidRequest', `Unexpected property '${property}'.`);
      }
    }
    this.indexes.set(name, {
      definition: { ...body, fields },
      etag: (existing?.etag ?? 0) + 1,
    });
    if (!this.documents.has(name)) {
      this.documents.set(name, new Map());
    }
    return { status: existing === undefined ? 201 : 204 };
  }

  #inPlaceProblem(current: Json, fields: readonly Json[]): string | undefined {
    const next = new Map(fields.map((field) => [String(field['name']), field]));
    for (const field of current['fields'] as Json[]) {
      const name = String(field['name']);
      const replacement = next.get(name);
      if (replacement === undefined) {
        return `Existing field '${name}' cannot be removed.`;
      }
      for (const attribute of IMMUTABLE_FIELD_ATTRIBUTES) {
        if (JSON.stringify(field[attribute]) !== JSON.stringify(replacement[attribute])) {
          return `Existing field '${name}' cannot be changed: ${attribute}.`;
        }
      }
    }
    return undefined;
  }

  #indexDocuments(name: string, rawBody: string): FakeResponse {
    let body: { value?: Json[] };
    try {
      body = JSON.parse(rawBody) as { value?: Json[] };
    } catch {
      return errorResponse(400, 'InvalidRequest', 'Malformed JSON.');
    }
    const actions = body.value ?? [];
    if (actions.length > 1000) {
      return errorResponse(413, 'RequestEntityTooLarge', 'Too many documents.');
    }
    const store = this.documents.get(name) ?? new Map<string, Json>();
    this.documents.set(name, store);
    const results = actions.map((action) => {
      const key = String(action['id']);
      const scripted = this.documentFailures.get(key);
      const failure = scripted?.shift();
      if (failure !== undefined) {
        return {
          key,
          status: false,
          errorMessage: `Document failed with value '${typeof action['content'] === 'string' ? action['content'] : 'x'}'.`,
          statusCode: failure,
        };
      }
      const { '@search.action': kind, ...fields } = action;
      const existed = store.has(key);
      if (kind === 'delete') {
        store.delete(key);
        return { key, status: true, errorMessage: null, statusCode: 200 };
      }
      store.set(key, kind === 'mergeOrUpload' ? { ...(store.get(key) ?? {}), ...fields } : fields);
      return { key, status: true, errorMessage: null, statusCode: existed ? 200 : 201 };
    });
    return json(results.every((result) => result.status) ? 200 : 207, { value: results });
  }

  #search(name: string, index: StoredIndex, rawBody: string): FakeResponse {
    const body = JSON.parse(rawBody) as {
      filter?: string;
      select?: string;
      top?: number;
      orderby?: string;
      queryType?: string;
    };
    const fields = index.definition['fields'] as Json[];
    const retrievable = new Set(
      fields.filter((field) => field['retrievable'] === true).map((field) => String(field['name'])),
    );
    const selected = (body.select ?? '').split(',').filter((field) => field !== '');
    for (const field of selected) {
      if (!retrievable.has(field)) {
        return errorResponse(400, 'InvalidRequest', `Field '${field}' is not retrievable.`);
      }
    }
    let matches = [...(this.documents.get(name)?.values() ?? [])].filter((document) =>
      matchesFilter(document, body.filter),
    );
    if (body.orderby === 'id asc') {
      matches = matches.sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1));
    }
    const value = matches.slice(0, body.top ?? 50).map((document, position) => {
      const projected: Json = {};
      for (const field of selected.length > 0 ? selected : [...retrievable]) {
        projected[field] = document[field] ?? null;
      }
      return {
        '@search.score': 1 / (position + 1),
        ...(body.queryType === 'semantic' ? { '@search.rerankerScore': 3 - position * 0.1 } : {}),
        ...projected,
      };
    });
    return json(200, { value });
  }
}
