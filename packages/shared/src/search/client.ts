import { z } from 'zod';

import { createLogger, type Logger } from '../logging/logger.js';
import type { SearchAuthenticator } from './auth.js';
import { SearchCredentialError } from './auth.js';
import {
  retrievedDocumentSchema,
  searchDocumentSchema,
  type RetrievedDocument,
  type SearchDocument,
} from './documents.js';
import {
  SearchServiceError,
  isSearchServiceError,
  sanitizeServiceMessage,
  type SearchErrorCategory,
} from './errors.js';
import {
  DEFAULT_SEARCH_RETRY_POLICY,
  defaultSleep,
  errorFromFetchFailure,
  errorFromHttpResponse,
  parseRetryAfterHeaders,
  readTextWithLimit,
  retryDelay,
  type RandomSource,
  type SearchFetch,
  type SearchRetryPolicy,
  type Sleep,
} from './http.js';
import {
  SEARCH_API_VERSION,
  SEARCH_SCHEMA_VERSION,
  VECTOR_FIELD_NAME,
  buildIndexDefinition,
  type SearchIndexDefinition,
} from './indexDefinition.js';
import {
  buildListScopeFilter,
  buildScopeFilter,
  odataString,
  type ChunkListScope,
  type DocumentScope,
} from './odata.js';
import { buildSearchRequest, type SearchQuery, type SearchRequestPlan } from './query.js';
import {
  buildInPlaceUpdate,
  compareIndexDefinitions,
  deployedIndexSchema,
  type DeployedIndex,
  type SchemaDifference,
} from './schemaComparison.js';

export interface SearchCallOptions {
  readonly signal?: AbortSignal;
}

export type IndexValidationStatus = 'missing' | 'match' | 'compatible-changes' | 'incompatible';

export interface IndexValidationResult {
  readonly indexName: string;
  readonly status: IndexValidationStatus;
  readonly expectedSchemaVersion: number;
  readonly deployedSchemaVersion: number | undefined;
  readonly differences: readonly SchemaDifference[];
}

export type CreateOrUpdateOutcome =
  | 'created'
  | 'unchanged'
  | 'updated'
  /** Compatible changes exist but applying them was not requested. */
  | 'changes-pending'
  /** The deployed index cannot be brought in line in place; nothing was changed. */
  | 'migration-required';

export interface CreateOrUpdateIndexResult {
  readonly outcome: CreateOrUpdateOutcome;
  /** The comparison before any change was made (status `missing` when the index was created). */
  readonly validation: IndexValidationResult;
}

export interface CreateOrUpdateIndexOptions extends SearchCallOptions {
  /** Apply in-place compatible changes to an existing index. Never deletes or recreates. */
  readonly applyCompatibleChanges?: boolean;
}

export type IndexingAction = 'upload' | 'mergeOrUpload' | 'delete';

export type IndexingFailureReason =
  /** The service rejected the document (HTTP 400 for the item, or the whole batch). */
  | 'rejected'
  /** A transient per-document error (409/422/503) persisted through every retry. */
  | 'retries-exhausted'
  | 'not-found'
  | 'too-large'
  | 'missing-from-response';

export interface IndexingFailure {
  readonly key: string;
  readonly reason: IndexingFailureReason;
  readonly statusCode: number | undefined;
  /** Sanitized: quoted values removed, bounded length. */
  readonly message: string | undefined;
}

/** Counts and failure keys only; never document contents. */
export interface IndexingReport {
  readonly action: IndexingAction;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: readonly IndexingFailure[];
  readonly requests: number;
  /** Documents re-sent after a transient per-document failure. */
  readonly retriedDocuments: number;
  readonly durationMs: number;
}

export interface DeletionReport extends IndexingReport {
  /** Chunks the scope matched when the deletion started. */
  readonly matched: number;
}

/** Where an indexed chunk belongs; listing returns no content. */
export interface IndexedChunkKey {
  readonly id: string;
  readonly courseId: number;
  readonly resourceId: string;
}

export interface SearchHit {
  readonly document: RetrievedDocument;
  readonly score: number;
  readonly rerankerScore: number | undefined;
}

export interface SearchResults {
  readonly hits: readonly SearchHit[];
  readonly mode: SearchRequestPlan['mode'];
  readonly semanticApplied: boolean;
  readonly durationMs: number;
}

export type SearchHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface SearchHealthReport {
  readonly status: SearchHealthStatus;
  readonly authMode: SearchAuthenticator['mode'];
  readonly indexName: string;
  readonly serviceReachable: boolean;
  readonly latencyMs: number;
  readonly serviceCounters?: Readonly<Record<string, { usage: number; quota: number | null }>>;
  readonly index?: {
    readonly exists: boolean;
    readonly documentCount?: number;
    readonly storageSizeBytes?: number;
    readonly vectorIndexSizeBytes?: number;
  };
  readonly schema?: IndexValidationStatus;
  /** Sanitized descriptions of what is wrong; empty when healthy. */
  readonly problems: readonly string[];
  /** Set when the check stopped on an error, so callers can explain it. */
  readonly failure?: { readonly category: SearchErrorCategory; readonly httpStatus?: number };
}

/**
 * Azure AI Search operations used by the indexer and the answer service. Implementations must
 * apply the security filter on every query and never log keys, tokens or document contents.
 */
export interface SearchIndexClient {
  readonly indexName: string;
  readonly expectedDefinition: SearchIndexDefinition;
  createOrUpdateIndex(options?: CreateOrUpdateIndexOptions): Promise<CreateOrUpdateIndexResult>;
  validateIndexSchema(options?: SearchCallOptions): Promise<IndexValidationResult>;
  /** The deployed vector field's dimensions, or undefined when the index or field is missing. */
  getDeployedVectorDimensions(options?: SearchCallOptions): Promise<number | undefined>;
  uploadChunks(
    documents: readonly SearchDocument[],
    options?: SearchCallOptions,
  ): Promise<IndexingReport>;
  mergeOrUploadChunks(
    documents: readonly SearchDocument[],
    options?: SearchCallOptions,
  ): Promise<IndexingReport>;
  deleteChunksByResource(
    scope: Required<DocumentScope>,
    options?: SearchCallOptions,
  ): Promise<DeletionReport>;
  deleteChunksByCourse(
    scope: Omit<DocumentScope, 'resourceId'>,
    options?: SearchCallOptions,
  ): Promise<DeletionReport>;
  /** Keys of every chunk in a tenant, course or resource, ordered by key. */
  listChunkKeys(scope: ChunkListScope, options?: SearchCallOptions): Promise<IndexedChunkKey[]>;
  deleteChunksByKeys(keys: readonly string[], options?: SearchCallOptions): Promise<IndexingReport>;
  search(query: SearchQuery, options?: SearchCallOptions): Promise<SearchResults>;
  healthCheck(options?: SearchCallOptions): Promise<SearchHealthReport>;
}

export interface RestSearchIndexClientOptions {
  /** e.g. https://contoso-search.search.windows.net */
  readonly endpoint: string;
  readonly indexName: string;
  readonly vectorDimensions: number;
  readonly semanticEnabled: boolean;
  readonly authenticator: SearchAuthenticator;
  /** Maximum documents per indexing request (Azure's limit is 1000). */
  readonly batchSize?: number;
  /** Maximum request body per indexing request (Azure's limit is 16 MB). */
  readonly maxBatchBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly retryPolicy?: SearchRetryPolicy;
  readonly maxResponseBytes?: number;
  readonly fetch?: SearchFetch;
  readonly logger?: Logger;
  readonly sleep?: Sleep;
  readonly random?: RandomSource;
  readonly userAgent?: string;
}

export const AZURE_MAX_BATCH_DOCUMENTS = 1000;
export const DEFAULT_MAX_BATCH_BYTES = 15 * 1024 * 1024;
const KEY_PAGE_SIZE = 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Per-document statuses Azure documents as transient. */
const RETRYABLE_ITEM_STATUSES: ReadonlySet<number> = new Set([409, 422, 503]);

const indexingResultSchema = z.object({
  value: z.array(
    z.object({
      key: z.string(),
      status: z.boolean(),
      errorMessage: z.string().nullish(),
      statusCode: z.number().int(),
    }),
  ),
});

const searchResponseSchema = z.object({
  value: z.array(
    z.looseObject({
      '@search.score': z.number(),
      '@search.rerankerScore': z.number().nullish(),
    }),
  ),
  '@search.semanticPartialResponseReason': z.string().nullish(),
});

const keyPageSchema = z.object({
  value: z.array(z.object({ id: z.string(), courseId: z.number().int(), resourceId: z.string() })),
});
const KEY_PATTERN = /^[0-9a-f]{64}$/;

const indexStatsSchema = z.looseObject({
  documentCount: z.number(),
  storageSize: z.number(),
  vectorIndexSize: z.number().nullish(),
});

const serviceStatsSchema = z.looseObject({
  counters: z.record(
    z.string(),
    z.looseObject({ usage: z.number(), quota: z.number().nullish() }).nullish(),
  ),
});

interface HttpResult {
  readonly status: number;
  readonly text: string;
  readonly etag: string | undefined;
}

interface RequestSpec {
  readonly operation: string;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Statuses returned to the caller rather than raised. */
  readonly accept: readonly number[];
  readonly includeServiceMessage: boolean;
  readonly signal: AbortSignal | undefined;
}

interface PreparedAction {
  readonly key: string;
  readonly json: string;
  readonly bytes: number;
}

function deleteAction(key: string): PreparedAction {
  const json = JSON.stringify({ '@search.action': 'delete', id: key });
  return { key, json, bytes: Buffer.byteLength(json) };
}

const silentLogger = createLogger({ service: 'search-client', level: 'silent' });

function normalizeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError('The Azure AI Search endpoint is not a valid URL.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError('The Azure AI Search endpoint must be an https URL without credentials.');
  }
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('The Azure AI Search endpoint must not have a path or query.');
  }
  return url.origin;
}

function invalidResponse(operation: string): SearchServiceError {
  return new SearchServiceError(`Azure AI Search ${operation} returned an unexpected response.`, {
    category: 'invalid_response',
    operation,
  });
}

function parseJson<T>(text: string, schema: z.ZodType<T>, operation: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidResponse(operation);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw invalidResponse(operation);
  }
  return result.data;
}

export class RestSearchIndexClient implements SearchIndexClient {
  readonly indexName: string;
  readonly expectedDefinition: SearchIndexDefinition;
  readonly #endpoint: string;
  readonly #options: RestSearchIndexClientOptions;
  readonly #fetch: SearchFetch;
  readonly #logger: Logger;
  readonly #retryPolicy: SearchRetryPolicy;
  readonly #sleep: Sleep;
  readonly #random: RandomSource;
  readonly #batchSize: number;
  readonly #maxBatchBytes: number;

  constructor(options: RestSearchIndexClientOptions) {
    this.#endpoint = normalizeEndpoint(options.endpoint);
    this.indexName = options.indexName;
    this.expectedDefinition = buildIndexDefinition({
      indexName: options.indexName,
      vectorDimensions: options.vectorDimensions,
      semanticEnabled: options.semanticEnabled,
    });
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#logger = (options.logger ?? silentLogger).child({ component: 'search-client' });
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_SEARCH_RETRY_POLICY;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#batchSize = Math.min(options.batchSize ?? 500, AZURE_MAX_BATCH_DOCUMENTS);
    this.#maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    if (this.#batchSize < 1 || this.#maxBatchBytes < 1024) {
      throw new RangeError('Batch limits are too small.');
    }
  }

  get #indexPath(): string {
    return `/indexes/${encodeURIComponent(this.indexName)}`;
  }

  // ---------------------------------------------------------------- index management

  async #getDeployedIndex(signal: AbortSignal | undefined): Promise<DeployedIndex | undefined> {
    const result = await this.#request({
      operation: 'getIndex',
      method: 'GET',
      path: this.#indexPath,
      accept: [200, 404],
      includeServiceMessage: true,
      signal,
    });
    if (result.status === 404) {
      return undefined;
    }
    const deployed = parseJson(result.text, deployedIndexSchema, 'getIndex');
    return result.etag === undefined || deployed['@odata.etag'] !== undefined
      ? deployed
      : { ...deployed, '@odata.etag': result.etag };
  }

  #validationFor(deployed: DeployedIndex | undefined): IndexValidationResult {
    if (deployed === undefined) {
      return {
        indexName: this.indexName,
        status: 'missing',
        expectedSchemaVersion: SEARCH_SCHEMA_VERSION,
        deployedSchemaVersion: undefined,
        differences: [],
      };
    }
    const comparison = compareIndexDefinitions(this.expectedDefinition, deployed);
    return {
      indexName: this.indexName,
      status: comparison.status,
      expectedSchemaVersion: SEARCH_SCHEMA_VERSION,
      deployedSchemaVersion: comparison.deployedSchemaVersion,
      differences: comparison.differences,
    };
  }

  async validateIndexSchema(options: SearchCallOptions = {}): Promise<IndexValidationResult> {
    return this.#validationFor(await this.#getDeployedIndex(options.signal));
  }

  async getDeployedVectorDimensions(options: SearchCallOptions = {}): Promise<number | undefined> {
    const deployed = await this.#getDeployedIndex(options.signal);
    const field = deployed?.fields.find((entry) => entry.name === VECTOR_FIELD_NAME);
    return field?.dimensions ?? undefined;
  }

  async createOrUpdateIndex(
    options: CreateOrUpdateIndexOptions = {},
  ): Promise<CreateOrUpdateIndexResult> {
    const deployed = await this.#getDeployedIndex(options.signal);
    const validation = this.#validationFor(deployed);

    if (deployed === undefined) {
      // If-None-Match: * makes this create-only: it can never replace an index created
      // concurrently by another process.
      const created = await this.#request({
        operation: 'createIndex',
        method: 'PUT',
        path: this.#indexPath,
        body: JSON.stringify(this.expectedDefinition),
        headers: { 'if-none-match': '*', prefer: 'return=minimal' },
        accept: [200, 201, 204],
        includeServiceMessage: true,
        signal: options.signal,
      });
      this.#logger.info('Search index created.', {
        indexName: this.indexName,
        httpStatus: created.status,
        schemaVersion: SEARCH_SCHEMA_VERSION,
      });
      return { outcome: 'created', validation };
    }

    switch (validation.status) {
      case 'match':
        return { outcome: 'unchanged', validation };
      case 'incompatible':
        this.#logger.warn('Search index schema needs a migration.', {
          indexName: this.indexName,
          incompatible: validation.differences.filter((d) => d.severity === 'incompatible').length,
        });
        return { outcome: 'migration-required', validation };
      case 'compatible-changes':
      case 'missing':
        break;
    }
    if (options.applyCompatibleChanges !== true) {
      return { outcome: 'changes-pending', validation };
    }

    const etag = deployed['@odata.etag'];
    await this.#request({
      operation: 'updateIndex',
      method: 'PUT',
      path: this.#indexPath,
      body: JSON.stringify(buildInPlaceUpdate(this.expectedDefinition, deployed)),
      // If-Match fails the update (412) if the index changed since it was read; without an
      // ETag, If-Match: * at least guarantees this never creates an index.
      headers: { 'if-match': etag ?? '*', prefer: 'return=minimal' },
      accept: [200, 201, 204],
      includeServiceMessage: true,
      signal: options.signal,
    });
    this.#logger.info('Search index updated in place.', {
      indexName: this.indexName,
      changes: validation.differences.filter((d) => d.severity === 'compatible').length,
    });
    return { outcome: 'updated', validation };
  }

  // ---------------------------------------------------------------- documents

  // async so invalid input surfaces as a rejected promise, never a synchronous throw.
  async uploadChunks(
    documents: readonly SearchDocument[],
    options: SearchCallOptions = {},
  ): Promise<IndexingReport> {
    return await this.#indexDocuments(
      'upload',
      this.#prepareDocuments('upload', documents),
      options,
    );
  }

  async mergeOrUploadChunks(
    documents: readonly SearchDocument[],
    options: SearchCallOptions = {},
  ): Promise<IndexingReport> {
    return await this.#indexDocuments(
      'mergeOrUpload',
      this.#prepareDocuments('mergeOrUpload', documents),
      options,
    );
  }

  deleteChunksByResource(
    scope: Required<DocumentScope>,
    options: SearchCallOptions = {},
  ): Promise<DeletionReport> {
    return this.#deleteByScope(scope, options);
  }

  deleteChunksByCourse(
    scope: Omit<DocumentScope, 'resourceId'>,
    options: SearchCallOptions = {},
  ): Promise<DeletionReport> {
    return this.#deleteByScope({ tenantId: scope.tenantId, courseId: scope.courseId }, options);
  }

  async listChunkKeys(
    scope: ChunkListScope,
    options: SearchCallOptions = {},
  ): Promise<IndexedChunkKey[]> {
    return await this.#listKeys(buildListScopeFilter(scope), options.signal);
  }

  async deleteChunksByKeys(
    keys: readonly string[],
    options: SearchCallOptions = {},
  ): Promise<IndexingReport> {
    const unique = [...new Set(keys)];
    for (const key of unique) {
      if (!KEY_PATTERN.test(key)) {
        throw new SearchServiceError('A chunk key is not a valid document key.', {
          category: 'invalid_request',
          operation: 'delete',
        });
      }
    }
    return await this.#indexDocuments('delete', unique.map(deleteAction), options);
  }

  #prepareDocuments(
    action: IndexingAction,
    documents: readonly SearchDocument[],
  ): PreparedAction[] {
    const seen = new Set<string>();
    return documents.map((document, position) => {
      const parsed = searchDocumentSchema.safeParse(document);
      if (!parsed.success) {
        // Field paths only: issue messages could quote document values.
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
        throw new SearchServiceError(
          `Document at position ${String(position)} is invalid (fields: ${fields.join(', ')}).`,
          { category: 'invalid_request', operation: action },
        );
      }
      if (parsed.data.contentVector.length !== this.#options.vectorDimensions) {
        throw new SearchServiceError(
          `Document at position ${String(position)} has a ${String(parsed.data.contentVector.length)}-dimension vector; the index expects ${String(this.#options.vectorDimensions)}.`,
          { category: 'invalid_request', operation: action },
        );
      }
      if (seen.has(parsed.data.id)) {
        throw new SearchServiceError(`Document key ${parsed.data.id} appears more than once.`, {
          category: 'invalid_request',
          operation: action,
        });
      }
      seen.add(parsed.data.id);
      const json = JSON.stringify({ '@search.action': action, ...parsed.data });
      return { key: parsed.data.id, json, bytes: Buffer.byteLength(json) };
    });
  }

  #planBatches(actions: readonly PreparedAction[]): {
    batches: PreparedAction[][];
    oversized: PreparedAction[];
  } {
    const batches: PreparedAction[][] = [];
    const oversized: PreparedAction[] = [];
    // `{"value":[` + `]}` + separating commas.
    const envelope = 12;
    let current: PreparedAction[] = [];
    let bytes = envelope;
    for (const action of actions) {
      if (action.bytes + envelope > this.#maxBatchBytes) {
        oversized.push(action);
        continue;
      }
      if (
        current.length > 0 &&
        (current.length >= this.#batchSize || bytes + action.bytes + 1 > this.#maxBatchBytes)
      ) {
        batches.push(current);
        current = [];
        bytes = envelope;
      }
      current.push(action);
      bytes += action.bytes + 1;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return { batches, oversized };
  }

  async #indexDocuments(
    action: IndexingAction,
    actions: readonly PreparedAction[],
    options: SearchCallOptions,
  ): Promise<IndexingReport> {
    const started = Date.now();
    const failed: IndexingFailure[] = [];
    let succeeded = 0;
    let requests = 0;
    let retriedDocuments = 0;

    const { batches, oversized } = this.#planBatches(actions);
    for (const action of oversized) {
      failed.push({
        key: action.key,
        reason: 'too-large',
        statusCode: undefined,
        message: 'Document exceeds the request size limit.',
      });
    }

    let pending = batches;
    for (let round = 0; pending.length > 0; round += 1) {
      const retry: PreparedAction[] = [];
      const lastRound = round >= this.#retryPolicy.maxRetries;
      for (const batch of pending) {
        requests += 1;
        const outcome = await this.#sendBatch(batch, options.signal);
        if (outcome.kind === 'rejected') {
          for (const item of batch) {
            failed.push({
              key: item.key,
              reason: 'rejected',
              statusCode: outcome.statusCode,
              message: outcome.message,
            });
          }
          continue;
        }
        if (outcome.kind === 'too-large') {
          // Split and resend in the same round; a single document cannot be split further.
          if (batch.length === 1) {
            const only = batch[0];
            if (only !== undefined) {
              failed.push({
                key: only.key,
                reason: 'too-large',
                statusCode: 413,
                message: 'Document exceeds the request size limit.',
              });
            }
          } else {
            const middle = Math.ceil(batch.length / 2);
            pending.push(batch.slice(0, middle), batch.slice(middle));
          }
          continue;
        }
        const byKey = new Map(batch.map((item) => [item.key, item]));
        for (const item of outcome.results) {
          const prepared = byKey.get(item.key);
          if (prepared === undefined) {
            continue;
          }
          byKey.delete(item.key);
          if (item.status && (item.statusCode === 200 || item.statusCode === 201)) {
            succeeded += 1;
          } else if (RETRYABLE_ITEM_STATUSES.has(item.statusCode) && !lastRound) {
            retry.push(prepared);
          } else {
            failed.push({
              key: item.key,
              reason: RETRYABLE_ITEM_STATUSES.has(item.statusCode)
                ? 'retries-exhausted'
                : item.statusCode === 404
                  ? 'not-found'
                  : 'rejected',
              statusCode: item.statusCode,
              message:
                item.errorMessage === undefined || item.errorMessage === null
                  ? undefined
                  : sanitizeServiceMessage(item.errorMessage),
            });
          }
        }
        for (const missing of byKey.values()) {
          failed.push({
            key: missing.key,
            reason: 'missing-from-response',
            statusCode: undefined,
            message: undefined,
          });
        }
      }
      if (retry.length === 0) {
        break;
      }
      retriedDocuments += retry.length;
      const delay = retryDelay(round, this.#retryPolicy, undefined, this.#random) ?? 0;
      this.#logger.warn('Retrying documents after transient indexing failures.', {
        action,
        documents: retry.length,
        round: round + 1,
        delayMs: delay,
      });
      await this.#sleep(delay, options.signal);
      pending = this.#planBatches(retry).batches;
    }

    const report: IndexingReport = {
      action,
      attempted: actions.length,
      succeeded,
      failed,
      requests,
      retriedDocuments,
      durationMs: Date.now() - started,
    };
    this.#logger.info('Indexing batch completed.', {
      action,
      attempted: report.attempted,
      succeeded,
      failed: failed.length,
      requests,
      retriedDocuments,
      durationMs: report.durationMs,
    });
    return report;
  }

  async #sendBatch(
    batch: readonly PreparedAction[],
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'results'; results: z.output<typeof indexingResultSchema>['value'] }
    | { kind: 'rejected'; statusCode: number; message: string }
    | { kind: 'too-large' }
  > {
    let result: HttpResult;
    try {
      result = await this.#request({
        operation: 'indexDocuments',
        method: 'POST',
        path: `${this.#indexPath}/docs/index`,
        body: `{"value":[${batch.map((item) => item.json).join(',')}]}`,
        accept: [200, 207],
        includeServiceMessage: false,
        signal,
      });
    } catch (error) {
      if (isSearchServiceError(error) && error.category === 'request_too_large') {
        return { kind: 'too-large' };
      }
      // A 400 for the whole batch means one document the schema check missed; the rest of the
      // run can continue. Anything else (auth, missing index, outage) affects every batch.
      if (isSearchServiceError(error) && error.httpStatus === 400) {
        return { kind: 'rejected', statusCode: 400, message: error.message };
      }
      throw error;
    }
    return {
      kind: 'results',
      results: parseJson(result.text, indexingResultSchema, 'indexDocuments').value,
    };
  }

  async #listKeys(filter: string, signal: AbortSignal | undefined): Promise<IndexedChunkKey[]> {
    const keys: IndexedChunkKey[] = [];
    let after: string | undefined;
    for (;;) {
      // Keyset paging on the key field: $skip is capped at 100,000 and shifts as documents
      // are deleted, whereas "id gt last" stays correct.
      const body = {
        search: '*',
        filter: after === undefined ? filter : `${filter} and id gt ${odataString(after)}`,
        select: 'id,courseId,resourceId',
        orderby: 'id asc',
        top: KEY_PAGE_SIZE,
      };
      const result = await this.#request({
        operation: 'listKeys',
        method: 'POST',
        path: `${this.#indexPath}/docs/search`,
        body: JSON.stringify(body),
        accept: [200],
        includeServiceMessage: false,
        signal,
      });
      const page = parseJson(result.text, keyPageSchema, 'listKeys').value;
      keys.push(...page);
      const last = page.at(-1);
      if (page.length < KEY_PAGE_SIZE || last === undefined) {
        return keys;
      }
      after = last.id;
    }
  }

  async #deleteByScope(scope: DocumentScope, options: SearchCallOptions): Promise<DeletionReport> {
    const keys = await this.#listKeys(buildScopeFilter(scope), options.signal);
    const report = await this.#indexDocuments(
      'delete',
      keys.map((entry) => deleteAction(entry.id)),
      options,
    );
    return { ...report, matched: keys.length };
  }

  // ---------------------------------------------------------------- queries

  async search(query: SearchQuery, options: SearchCallOptions = {}): Promise<SearchResults> {
    const started = Date.now();
    // Built first so an unscoped or malformed query fails before any network traffic.
    const plan = buildSearchRequest(query, {
      vectorDimensions: this.#options.vectorDimensions,
      semanticEnabled: this.#options.semanticEnabled,
    });
    const { body, semantic } = plan;
    const result = await this.#request({
      operation: 'search',
      method: 'POST',
      path: `${this.#indexPath}/docs/search`,
      body: JSON.stringify(body),
      accept: [200, 206],
      includeServiceMessage: false,
      signal: options.signal,
    });
    const response = parseJson(result.text, searchResponseSchema, 'search');
    const hits: SearchHit[] = response.value.map((raw) => {
      const document = retrievedDocumentSchema.safeParse(raw);
      // A document that does not match the schema cannot be cited safely.
      if (
        !document.success ||
        document.data.tenantId !== query.tenantId ||
        !plan.effectiveCourseIds.has(document.data.courseId) ||
        !document.data.isActive
      ) {
        throw invalidResponse('search');
      }
      return {
        document: document.data,
        score: raw['@search.score'],
        rerankerScore: raw['@search.rerankerScore'] ?? undefined,
      };
    });
    const durationMs = Date.now() - started;
    this.#logger.debug('Search completed.', {
      hits: hits.length,
      semantic,
      mode: plan.mode,
      durationMs,
    });
    return {
      hits,
      mode: plan.mode,
      semanticApplied:
        semantic && (response['@search.semanticPartialResponseReason'] ?? undefined) === undefined,
      durationMs,
    };
  }

  async healthCheck(options: SearchCallOptions = {}): Promise<SearchHealthReport> {
    const started = Date.now();
    const problems: string[] = [];
    const base = { authMode: this.#options.authenticator.mode, indexName: this.indexName };
    let serviceCounters: SearchHealthReport['serviceCounters'];
    let degraded = false;

    try {
      const stats = await this.#request({
        operation: 'getServiceStatistics',
        method: 'GET',
        path: '/servicestats',
        accept: [200],
        includeServiceMessage: false,
        signal: options.signal,
      });
      const counters: Record<string, { usage: number; quota: number | null }> = {};
      for (const [name, counter] of Object.entries(
        parseJson(stats.text, serviceStatsSchema, 'getServiceStatistics').counters,
      )) {
        if (counter !== null && counter !== undefined) {
          counters[name] = { usage: counter.usage, quota: counter.quota ?? null };
        }
      }
      serviceCounters = counters;
    } catch (error) {
      // Service statistics need management-level access; a data-plane-only identity can still
      // index and query, so a 403 here degrades rather than fails the check.
      if (isSearchServiceError(error) && error.category === 'authorization') {
        degraded = true;
        problems.push('Service statistics are not readable with this credential (HTTP 403).');
      } else {
        return {
          ...base,
          status: 'unhealthy',
          serviceReachable: !(
            isSearchServiceError(error) && ['network', 'timeout'].includes(error.category)
          ),
          latencyMs: Date.now() - started,
          problems: [describeError(error)],
          ...failureOf(error),
        };
      }
    }

    let index: SearchHealthReport['index'];
    let schema: IndexValidationStatus | undefined;
    try {
      const validation = await this.validateIndexSchema(options);
      schema = validation.status;
      if (validation.status === 'missing') {
        index = { exists: false };
        problems.push(`Index ${this.indexName} does not exist.`);
      } else {
        const stats = await this.#request({
          operation: 'getIndexStatistics',
          method: 'GET',
          path: `${this.#indexPath}/stats`,
          accept: [200],
          includeServiceMessage: false,
          signal: options.signal,
        });
        const parsed = parseJson(stats.text, indexStatsSchema, 'getIndexStatistics');
        index = {
          exists: true,
          documentCount: parsed.documentCount,
          storageSizeBytes: parsed.storageSize,
          ...(parsed.vectorIndexSize === null || parsed.vectorIndexSize === undefined
            ? {}
            : { vectorIndexSizeBytes: parsed.vectorIndexSize }),
        };
        if (validation.status === 'incompatible') {
          problems.push('The deployed index schema is incompatible with this version.');
        } else if (validation.status === 'compatible-changes') {
          degraded = true;
          problems.push('The deployed index schema has pending compatible changes.');
        }
      }
    } catch (error) {
      problems.push(describeError(error));
      return {
        ...failureOf(error),
        ...base,
        status: 'unhealthy',
        serviceReachable: serviceCounters !== undefined,
        latencyMs: Date.now() - started,
        ...(serviceCounters === undefined ? {} : { serviceCounters }),
        problems,
      };
    }

    const unhealthy = schema === 'missing' || schema === 'incompatible';
    return {
      ...base,
      status: unhealthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy',
      serviceReachable: true,
      latencyMs: Date.now() - started,
      ...(serviceCounters === undefined ? {} : { serviceCounters }),
      index,
      schema,
      problems,
    };
  }

  // ---------------------------------------------------------------- transport

  async #request(spec: RequestSpec): Promise<HttpResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#attempt(spec);
      } catch (error) {
        const normalized = isSearchServiceError(error)
          ? error
          : error instanceof SearchCredentialError
            ? new SearchServiceError(error.message, {
                category: 'authentication',
                operation: spec.operation,
              })
            : new SearchServiceError(`Azure AI Search ${spec.operation} failed unexpectedly.`, {
                category: 'invalid_response',
                operation: spec.operation,
              });
        const delay =
          normalized.retryable && attempt < this.#retryPolicy.maxRetries
            ? retryDelay(attempt, this.#retryPolicy, normalized.retryAfterMs, this.#random)
            : undefined;
        this.#logger.warn('Azure AI Search request failed.', {
          ...normalized.toLogFields(),
          attempt: attempt + 1,
          willRetry: delay !== undefined,
        });
        if (delay === undefined) {
          throw normalized;
        }
        try {
          await this.#sleep(delay, spec.signal);
        } catch {
          throw new SearchServiceError(`Azure AI Search ${spec.operation} was cancelled.`, {
            category: 'cancelled',
            operation: spec.operation,
          });
        }
      }
    }
  }

  async #attempt(spec: RequestSpec): Promise<HttpResult> {
    const timeout = AbortSignal.timeout(this.#options.requestTimeoutMs ?? 30_000);
    const signal = spec.signal === undefined ? timeout : AbortSignal.any([spec.signal, timeout]);
    const started = Date.now();
    const auth = await this.#options.authenticator.headers(signal);
    const url = `${this.#endpoint}${spec.path}?api-version=${SEARCH_API_VERSION}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: spec.method,
        headers: {
          accept: 'application/json',
          ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
          'user-agent': this.#options.userAgent ?? 'ehub-teams-assistant',
          ...spec.headers,
          ...auth,
        },
        ...(spec.body === undefined ? {} : { body: spec.body }),
        // Following a redirect would resend the api-key header to another host.
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw errorFromFetchFailure(
        error,
        spec.operation,
        timeout.aborted,
        spec.signal?.aborted === true,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SearchServiceError(
        `Azure AI Search ${spec.operation} returned an unexpected redirect.`,
        { category: 'invalid_response', operation: spec.operation, httpStatus: response.status },
      );
    }
    let text: string;
    try {
      text = await readTextWithLimit(
        response,
        this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        spec.operation,
      );
    } catch (error) {
      if (isSearchServiceError(error)) {
        throw error;
      }
      throw errorFromFetchFailure(
        error,
        spec.operation,
        timeout.aborted,
        spec.signal?.aborted === true,
      );
    }
    this.#logger.debug('Azure AI Search request completed.', {
      operation: spec.operation,
      httpStatus: response.status,
      durationMs: Date.now() - started,
    });
    if (spec.accept.includes(response.status)) {
      return { status: response.status, text, etag: response.headers.get('etag') ?? undefined };
    }
    throw errorFromHttpResponse({
      operation: spec.operation,
      status: response.status,
      body: text,
      retryAfterMs: parseRetryAfterHeaders(response.headers),
      includeServiceMessage: spec.includeServiceMessage,
    });
  }
}

function failureOf(error: unknown): Pick<SearchHealthReport, 'failure'> {
  if (!isSearchServiceError(error)) {
    return {};
  }
  return {
    failure: {
      category: error.category,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    },
  };
}

function describeError(error: unknown): string {
  return isSearchServiceError(error) ? error.message : 'Unexpected failure.';
}
