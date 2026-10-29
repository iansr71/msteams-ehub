# Azure AI Search index

Phase 6 defines the search index, a REST client for it and three operator commands. Nothing is
indexed yet: chunks are written by the synchronisation job in phase 11, with embeddings from
phase 8.

- Index definition: `packages/shared/src/search/indexDefinition.ts`
- Client (`SearchIndexClient` interface, `RestSearchIndexClient`): `packages/shared/src/search/client.ts`
- Schema comparison: `packages/shared/src/search/schemaComparison.ts`
- Filters (the only place filter strings are built): `packages/shared/src/search/odata.ts`
- Chunk → index document mapping: `apps/indexer/src/search/searchDocuments.ts`
- Commands: `apps/indexer/src/commands/searchCommands.ts`

The client calls the REST API directly with `api-version=2026-04-01` (the current GA version)
rather than using `@azure/search-documents`. That keeps the request bodies, the retry rules and
what can reach a log under this code's control, and lets tests run against an in-memory fake
service (`packages/shared/src/search/__fixtures__/fakeSearchService.ts`).

## Index `ehub-course-content-v1`

Every field attribute is stated explicitly. Azure's defaults make string fields searchable,
filterable, sortable and facetable, which would enlarge the index and make schema comparison
ambiguous.

| Field                                                 | Type               | Attributes                                       |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------ |
| `id`                                                  | String             | key, filterable, sortable                        |
| `tenantId`                                            | String             | filterable                                       |
| `courseId`                                            | Int32              | filterable, sortable, facetable                  |
| `courseName`                                          | String             | searchable (en.microsoft), filterable, facetable |
| `courseCategory`                                      | String             | filterable, facetable (Moodle category ID)       |
| `sectionId` / `moduleId`                              | Int32              | filterable                                       |
| `sectionName` / `moduleName` / `resourceName`/`title` | String             | searchable (en.microsoft)                        |
| `moduleUrl` / `sourceUrl`                             | String             | retrievable only                                 |
| `resourceId`                                          | String             | filterable (used to delete a resource's chunks)  |
| `resourceType` / `mimeType`                           | String             | filterable, facetable                            |
| `fileName`                                            | String             | searchable (standard analyser)                   |
| `headingPath`                                         | Collection(String) | searchable (en.microsoft)                        |
| `content`                                             | String             | searchable (en.microsoft)                        |
| `contentVector`                                       | Collection(Single) | vector, not retrievable, not stored              |
| `pageNumber` / `slideNumber`                          | Int32              | filterable                                       |
| `pageNumberEnd` / `chunkCount` / `tokenCount`         | Int32              | retrievable only                                 |
| `chunkNumber`                                         | Int32              | filterable, sortable                             |
| `contentHash` / `sourceContentHash`                   | String             | filterable (change detection in phase 11)        |
| `modifiedAt` / `indexedAt`                            | DateTimeOffset     | filterable, sortable                             |
| `extractorVersion` / `chunkerVersion`                 | String             | filterable, facetable                            |
| `embeddingModel` / `embeddingVersion`                 | String             | filterable, facetable (schema version 2)         |
| `embeddingDimensions`                                 | Int32              | retrievable only (schema version 2)              |
| `embeddedAt`                                          | DateTimeOffset     | filterable, sortable (schema version 2)          |
| `allowedUserIds` / `allowedGroupIds`                  | Collection(String) | filterable, **never retrievable**                |
| `isActive`                                            | Boolean            | filterable                                       |

- **Vector search:** HNSW, cosine, `m=4`, `efConstruction=400`, `efSearch=500`, profile
  `ehub-vector-profile`. Dimensions come from `AZURE_SEARCH_VECTOR_DIMENSIONS` (1536 for
  `text-embedding-3-small`; 3072 for `text-embedding-3-large`). A document whose vector has a
  different length is rejected before it is sent.
- **Semantic ranking:** configuration `ehub-semantic` (title `title`, content `content`,
  keywords `headingPath`, `resourceName`, `moduleName`, `courseName`). Needs a billable tier with
  the semantic ranker enabled; set `AZURE_SEARCH_SEMANTIC_ENABLED=false` otherwise.
- **Schema version:** recorded in the index description as `schema-version=2` and reported by
  `search:validate-index`. Version 2 (phase 8) added the four embedding fields. An index created
  with version 1 only lacks fields, which is a compatible change: run
  `pnpm indexer search:create-index --apply-compatible-changes`.

## Security trimming

`search()` builds the filter itself (`buildSearchRequest` in `query.ts`) and cannot be called
without an authorised course list:

```text
tenantId eq '<tenant>' and isActive eq true and (courseId eq 12 or courseId eq 15)
  [and (allowedUserIds/any(...) or allowedGroupIds/any(...))]   optional, when principals given
  [and search.in(resourceType, 'pdf,docx', ',')]                 optional resource-type filter
```

- Access is decided per course, matching phase 14: the caller's authorised Moodle course IDs
  are required and non-empty (`SearchScopeError: empty_scope` before any request otherwise).
  A requested course outside the authorised set is refused (`course_not_authorized`).
- Phase 6 originally required per-user/group principals instead. That was changed in phase 7:
  the access-list fields stay in the index as an optional extra restriction, but nothing
  populates them yet, and requiring them would have made every real search return nothing.
- Course IDs must be positive integers; user, group and tenant IDs must match
  `^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$`; resource types must be one of the extractor types.
  Other string values (resource IDs in deletions) have quotes doubled.
- Vector queries use `vectorFilterMode: preFilter`, so chunks outside the scope cannot push
  authorised ones out of the nearest-neighbour results.
- Results are validated; a result from another tenant, from a course outside the scope, or
  marked inactive fails the whole query.

## Authentication

| Where             | Method                                                       |
| ----------------- | ------------------------------------------------------------ |
| Local development | `AZURE_SEARCH_API_KEY` (admin key), sent as `api-key` header |
| Azure             | Leave the key unset: Microsoft Entra ID via Managed Identity |

When no key is set the client uses `DefaultAzureCredential` with scope
`https://search.azure.com/.default`. For that to work:

1. On the search service, set **Keys → API access control** to **Both** (or **Role-based access
   control**).
2. Grant the identity **Search Index Data Contributor** (upload, delete, query) and, for
   `search:create-index`, **Search Service Contributor** (index management). The answer service
   needs only **Search Index Data Reader**.
3. Note: `DefaultAzureCredential` tries environment credentials first. If `AZURE_TENANT_ID`,
   `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are all set, it signs in as that app
   registration, which then needs the roles above.

Reading service statistics needs management-level access. Without it `search:health` reports
`degraded` (not `unhealthy`) and says why.

The key is registered for log redaction when configuration loads, is never placed in a URL,
and redirects are not followed (a redirect would resend the header to another host).

## Commands

```bash
pnpm indexer search:health                                  # reachability, index, counts
pnpm indexer search:create-index                            # create if missing; never deletes
pnpm indexer search:validate-index                          # compare deployed schema with this version
pnpm indexer search:create-index --apply-compatible-changes # update in place, if safe
```

| Command                 | Exit 0                      | Exit 1                                                        |
| ----------------------- | --------------------------- | ------------------------------------------------------------- |
| `search:create-index`   | created, unchanged, updated | changes pending (flag not given), migration required, failure |
| `search:validate-index` | schema matches              | missing, compatible changes pending, incompatible, failure    |
| `search:health`         | healthy or degraded         | unhealthy or failure                                          |

Exit code 2 is a usage error. `--json` prints machine-readable output. Output contains names,
counts and statuses only; never keys, tokens or document text.

`search:create-index` is safe to run on every deployment:

- A missing index is created with `If-None-Match: *`, so it can never replace one created
  concurrently.
- An existing index is compared with this version. Compatible changes are applied only with
  `--apply-compatible-changes`, using the index ETag (`If-Match`), so a concurrent change fails
  with HTTP 412 instead of being overwritten. Deployed fields and settings this code does not
  manage (extra fields, scoring profiles, encryption key) are carried over unchanged.
- An incompatible difference is reported with migration guidance and nothing is changed.
- There is no delete command.

## What can change in place

Per Microsoft's documentation, Azure AI Search can add fields, change `retrievable`, and change
semantic configuration, scoring profiles, CORS and the description on an existing index. Most
other changes need a new index: a field's type, `searchable`, `filterable`, `sortable`,
`facetable`, `stored`, analyser, vector dimensions or profile, or removing a field.

`compareIndexDefinitions` classifies each difference:

| Severity        | Examples                                                                                        | Effect                          |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| `compatible`    | new field, `retrievable`, semantic configuration, description, new vector profile               | applied with the flag           |
| `incompatible`  | type, filterable/searchable/sortable/facetable, analyser, dimensions, HNSW parameters, `stored` | migration required              |
| `informational` | a deployed field this version does not use                                                      | none (fields cannot be removed) |

Anything not known to be safe in place is treated as incompatible.

## Schema versioning and migration

Index names carry a version: `ehub-course-content-v1`, `-v2`, … When a code change alters the
definition:

1. Increment `SEARCH_SCHEMA_VERSION` in `indexDefinition.ts`.
2. If the change is compatible, deploy and run `search:create-index --apply-compatible-changes`.
3. If it is incompatible (`search:validate-index` says so), do **not** delete the live index:
   1. Set `AZURE_SEARCH_INDEX_NAME` for the indexer to the next name, e.g.
      `ehub-course-content-v2`.
   2. Run `search:create-index`, then a full re-index (phase 11).
   3. Run `search:validate-index` and test queries against the new index.
   4. Switch the answer service to the new index (configuration change, or an index alias if
      the service's API version supports aliases for your tier).
   5. Delete the old index manually, in the portal, only after the new one has served traffic.

The default index name in code stays at the version in production until step 4.

## Indexing behaviour (used from phase 11)

- `uploadChunks` (`upload`) and `mergeOrUploadChunks` (`mergeOrUpload`) validate every document
  with Zod first, reject duplicate keys, and check vector dimensions.
- Batches are limited by `AZURE_SEARCH_BATCH_SIZE` (max 1000) and 15 MB per request (Azure's
  limit is 16 MB). A 413 response splits the batch.
- Whole-request failures: 408, 429, 500, 502, 503, 504, connection resets and timeouts are
  retried with full-jitter backoff, honouring `Retry-After` / `retry-after-ms`. 401, 403, 404 and
  other 4xx stop immediately.
- Per-document failures in a 207 response: 409, 422 and 503 are retried (only those
  documents); 400 and 404 are reported as failures. Azure's per-document 429 is documented as
  not retryable and is reported.
- A whole batch rejected with 400 is reported per document and the remaining batches continue.
- The result is an `IndexingReport`: counts, failed keys, reasons and sanitised messages (quoted
  values removed, because Azure messages can echo field values).
- `deleteChunksByResource` and `deleteChunksByCourse` list keys with keyset paging
  (`id gt '<last>'`, ordered by `id`) and delete them in batches. Both require a tenant ID and a
  course ID, so a deletion can never be unscoped.

## Tests

- Unit: `packages/shared/src/search/*.test.ts`, `apps/indexer/src/search/*.test.ts`,
  `apps/indexer/src/commands/searchCommands.test.ts` (fake service).
- Integration: `tests/integration/indexer-search-cli.test.ts` runs the real CLI over HTTPS
  against the fake service, with a throwaway self-signed certificate.
- Live (opt-in): `tests/integration/azure-search-live.test.ts` creates a temporary index named
  `ehub-live-test-<random>`, indexes three documents with placeholder vectors, checks security
  trimming and deletion, and deletes the temporary index. It never touches
  `AZURE_SEARCH_INDEX_NAME`.

  ```bash
  EHUB_LIVE_SEARCH_TESTS=1 pnpm vitest run --project integration tests/integration/azure-search-live.test.ts
  ```

  PowerShell: `$env:EHUB_LIVE_SEARCH_TESTS='1'; pnpm vitest run --project integration tests/integration/azure-search-live.test.ts`

The placeholder vectors (`placeholderVector` in the test fixtures) are deterministic hashes
with no meaning. They exist only in tests; real embeddings come from `docs/embeddings.md`.
