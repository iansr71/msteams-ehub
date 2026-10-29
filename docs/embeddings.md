# Embeddings

Phase 8 adds embedding generation behind the `EmbeddingProvider` interface
(`packages/shared/src/embeddings/`), an Azure OpenAI implementation, a cache, and the
integration with the indexer and retrieval.

```ts
interface EmbeddingProvider {
  embedText(text, options?): Promise<Embedding>;
  embedBatch(texts, options?): Promise<Embedding[]>; // input order preserved
  getDimensions(): number;
  getModelIdentifier(): string;
  getEmbeddingVersion(): string;
  healthCheck(options?): Promise<EmbeddingHealthReport>;
}
```

Each `Embedding` carries the vector plus metadata: model identifier, embedding version,
dimensions, generated timestamp, content hash and cache key.

## Azure OpenAI provider

`AzureOpenAIEmbeddingProvider` calls the Azure OpenAI v1 REST API directly:

```text
POST {AZURE_OPENAI_ENDPOINT}/openai/v1/embeddings
{ "model": "<deployment name>", "input": ["…", "…"], "encoding_format": "float" }
```

Per Microsoft's documentation the `model` value is the deployment name, one input may have at
most 8,192 tokens, one request at most 2,048 inputs and 300,000 tokens in total.

| Concern         | Behaviour                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication  | `AZURE_OPENAI_API_KEY` (`api-key` header) locally; otherwise Microsoft Entra ID via `DefaultAzureCredential` with scope `AZURE_OPENAI_TOKEN_SCOPE` (default `https://ai.azure.com/.default`)                             |
| Input           | Unicode NFC, control and invisible characters removed, whitespace collapsed; empty input is rejected                                                                                                                     |
| Input limit     | `EMBEDDING_MAX_INPUT_TOKENS` (default 8,191), counted with the `cl100k_base` tokenizer in the indexer and by UTF-8 bytes (an upper bound) in the API; over-long input is rejected, never truncated                       |
| Batching        | At most `EMBEDDING_BATCH_SIZE` inputs (default 64) and `EMBEDDING_MAX_BATCH_TOKENS` (default 100,000) per request; identical inputs are sent once                                                                        |
| Throttling      | Requests spaced evenly at `EMBEDDING_REQUESTS_PER_MINUTE` (default 120); at most `EMBEDDING_MAX_CONCURRENCY` (default 2) in flight                                                                                       |
| Retries         | 408, 429, 500, 502, 503, 504, connection resets and timeouts: up to `EMBEDDING_MAX_RETRIES` (default 4) with full-jitter exponential backoff (1 s base, 20 s cap), honouring `Retry-After` / `retry-after-ms` up to 60 s |
| Not retried     | 400 (invalid input), 401, 403, 404, refused connections, TLS errors                                                                                                                                                      |
| Response checks | One finite vector per input, each with exactly `AZURE_OPENAI_EMBEDDING_DIMENSIONS` values                                                                                                                                |
| Redirects       | Not followed (would resend the key or token)                                                                                                                                                                             |
| Logging         | Counts, token usage and durations only: never input text, vectors, keys or tokens. Error messages contain the HTTP status and Azure's error code, not Azure's message (which can quote the input)                        |

`AZURE_OPENAI_EMBEDDING_SEND_DIMENSIONS=true` sends `dimensions` in the request, which
`text-embedding-3-*` models use to return shorter vectors. Leave it `false` for the model's
native size (1,536 for `text-embedding-3-small`, 3,072 for `-large`).

### Entra ID in Azure

1. Leave `AZURE_OPENAI_API_KEY` empty.
2. Grant the indexer's and API's identities the **Cognitive Services OpenAI User** role on the
   Azure OpenAI resource.
3. If token requests fail with an audience error, set `AZURE_OPENAI_TOKEN_SCOPE` to
   `https://cognitiveservices.azure.com/.default` (the older scope).

As for Azure AI Search, `DefaultAzureCredential` signs in as the app registration when
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are all set.

## What is embedded

For each chunk the indexer embeds its location followed by its content:

```text
Aftercare.pdf > Aftercare > Sun protection

Use SPF 50 after a peel…
```

The location (resource name and heading path) helps short chunks, such as a list under a
heading, match questions about that heading. Questions are embedded as asked.

## Cache and regeneration

The cache key is SHA-256 of model identifier, embedding version, dimensions and the SHA-256 of
the normalised text. So:

- unchanged text with the same model and version is never re-embedded;
- a new model, a new `EMBEDDING_VERSION` or different dimensions always regenerates;
- a renamed heading or resource changes the embedded text and regenerates that chunk.

`CachingEmbeddingProvider` wraps the Azure provider. With `EMBEDDING_CACHE_DIR` set, entries are
files (`<dir>/<2 hex>/<key>.json`, written atomically, permissions 0600 / 0700) and survive
restarts; otherwise an in-memory cache of 10,000 entries is used. Corrupt or inconsistent entries
are treated as misses. The files hold vectors, not text, but vectors can reveal information about
the text, so protect the directory like the course content.

Each index document records `embeddingModel`, `embeddingVersion`, `embeddingDimensions` and
`embeddedAt` (index schema version 2), so phase 11 can skip unchanged chunks and find chunks that
need re-embedding after a model change.

Bump `EMBEDDING_VERSION` when the embedded text changes for a reason the cache cannot see, for
example a change to `buildEmbeddingText` or to input normalisation.

## Dimensions must match the index

`AZURE_OPENAI_EMBEDDING_DIMENSIONS` must equal `AZURE_SEARCH_VECTOR_DIMENSIONS` and the deployed
index's vector field. This is checked:

- by `embeddings:health` (configuration, the deployment's actual output and the deployed index);
- before `chunk:test --embed` embeds anything;
- when the API builds its query embedder (`pnpm api retrieve`, evaluation);
- per document by `toSearchDocument` and the search client.

Changing the embedding model or dimensions needs a new index (see `docs/search-index.md`).

## Retrieval

When the embedding settings are configured, `pnpm api retrieve` and `pnpm evaluation retrieval`
embed the question and run hybrid retrieval (text plus vector, pre-filtered). `--mode keyword`
skips the embedding. Partly configured embedding settings are an error, not a silent fallback to
keyword search.

## Commands

```bash
pnpm indexer embeddings:health                                # deployment, dimensions, index
pnpm indexer embeddings:test --text "consultation requirements"
pnpm indexer embeddings:test --text "..." --show-vector --json # whole vector, explicitly
pnpm indexer chunk:test --course-id <id> --resource-id <id> --embed
```

- `embeddings:health` exits 1 unless the deployment answers with the configured dimensions and
  those match the search configuration and the deployed index. A missing index or unconfigured
  search is reported but does not fail it.
- `embeddings:test` prints model, version, dimensions, timestamp, content hash, cache key,
  L2 norm and the first 5 values. The text is never printed, only its length.
- `chunk:test --embed` embeds a resource's chunks and validates the index documents it would
  upload; nothing is uploaded.

## Tests

- Unit: `packages/shared/src/embeddings/embeddings.test.ts` (fake service: batching, limits,
  retries, no retry on 4xx, throttling, concurrency, dimension checks, cache, redaction),
  `apps/indexer/src/search/chunkEmbedder.test.ts`, `apps/indexer/src/commands/embeddingCommands.test.ts`,
  retrieval tests in `apps/api`.
- Integration: `tests/integration/indexer-embeddings-cli.test.ts` runs the real CLI over HTTPS.
- Live (opt-in): `tests/integration/azure-openai-embeddings-live.test.ts`

  ```bash
  EHUB_LIVE_EMBEDDING_TESTS=1 pnpm vitest run --project integration tests/integration/azure-openai-embeddings-live.test.ts
  ```
