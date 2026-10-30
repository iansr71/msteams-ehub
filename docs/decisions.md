# Foundation decisions (phase 1)

Short records of choices made in phase 1 that later phases depend on.

## Toolchain versions are pinned below the newest releases

| Tool        | Pinned   | Newest at time of writing | Reason                                                  |
| ----------- | -------- | ------------------------- | ------------------------------------------------------- |
| TypeScript  | `~6.0.3` | 7.0.x                     | `typescript-eslint` 8.x supports TypeScript `<6.1` only |
| Vitest      | `^4.1`   | 5.0.x                     | Major upgrade deferred; 4.x supports Node 22            |
| @types/node | `^22`    | 26.x                      | Type definitions match the oldest supported runtime     |

Revisit when `typescript-eslint` supports TypeScript 7.

## Minimum Node.js is 22.13 (raised in phase 4)

Phase 1 started on Node 20.19. Phase 4 raised the minimum to **22.13** because the PDF parser
(`pdfjs-dist`) requires it from version 5 onward, and the last Node-20-compatible release
(4.10, January 2025) no longer receives security fixes — unacceptable for a component that
parses untrusted documents. Node 20 itself reached end of life in April 2026. This still
satisfies the project rule "Node.js 20 or later". Hosting (phase 19) must run Node 22 LTS or
newer.

## Workspace packages resolve to source during development

Each package exports a custom `@ehub/source` condition pointing at `src/index.ts`, enabled
through `customConditions` in `tsconfig.base.json`, `tsx --conditions=@ehub/source` and the
Vitest resolver. Type checking, tests and CLI runs therefore never need a prior build. Built
output (`tsc -b`, project references) resolves the normal `default` condition to `dist/`.

## A small in-house logger instead of pino

Redaction must apply to keys at any depth, case- and separator-insensitively, plus value
patterns (Moodle `wstoken=` URLs, bearer tokens) and registered secret values. pino's
path-based `redact` cannot express "any key named like `token` at any depth", so wrapping it
would have meant reimplementing redaction anyway. The `Logger` interface keeps the
implementation replaceable; phase 16 adds OpenTelemetry export behind it.

## Configuration is validated per feature group

`runtime`, `moodle`, `azureSearch`, `azureOpenAI`, `azureIdentity` and `observability` are
separate schemas, so each command validates only what it uses and health reports can show which
groups are missing. `applicationConfigSchema` validates everything for production start-up.
Production-only rules (https) are applied by `defineConfigSchema` to every group.

## CLI output contract

stdout carries only the command result (JSON for machine use); logs go to stderr. Unexpected
errors are logged through the redacting logger and reported as `{ "status": "error",
"correlationId": … }` with exit code 1.

## Tokenizer: js-tiktoken with cl100k_base (phase 5)

Chunk sizes are measured in the tokens of the model that consumes them: `cl100k_base` matches
Azure OpenAI `text-embedding-3-*`, `o200k_base` the GPT-4o family. `js-tiktoken` 1.0.21 (August
2025, a port of OpenAI's tiktoken) was chosen over `gpt-tokenizer` 4.x, whose latest releases
were days old. Two hazards were found and handled: by default it throws on `<|endoftext|>` in
input (documents are untrusted; special tokens are disabled), and its BPE is quadratic on long
repetitive runs (runs over 64 characters are bounded by UTF-8 length instead of encoded).

## Azure AI Search through REST, not the SDK (phase 6)

The search client calls the REST API (`api-version=2026-04-01`, GA) with `fetch` instead of
using `@azure/search-documents`. The client is small (index get/put, document batches, queries,
statistics), and owning the requests keeps three things under this code's control: the retry
rules (whole-request versus per-document), what can reach a log or error message (no headers,
no document values, no query text), and a fake service that tests can run against in-process
and over HTTPS. `@azure/identity` is still used for Microsoft Entra ID tokens, loaded only when
no API key is configured.

## The search index is never recreated by code (phase 6)

`search:create-index` creates a missing index (`If-None-Match: *`) and applies only in-place
compatible changes, and only when asked (`--apply-compatible-changes`, guarded by the index
ETag). Incompatible differences stop with migration guidance: a new versioned index is built
and switched to, and the old one is deleted by a person. There is no delete command, because
deleting the live index removes search for every user until a full re-index finishes.

## Search access is scoped by authorised course, not per-user lists (phase 7)

Phase 6 made `search()` require user or group principals matched against `allowedUserIds` /
`allowedGroupIds`. Prompts 9 and 14 define authorisation as the user's authorised Moodle
courses, applied as a course filter inside the search request. Per-user lists would also mean
rewriting every chunk of a course whenever an enrolment changes. Phase 7 therefore requires a
non-empty authorised course list on every query and refuses requested courses outside it; the
access-list fields remain in the index as an optional extra restriction. Under the phase 6
design, every real search would have returned nothing because nothing fills those lists.

## Inactive content is never retrievable (phase 7)

`isActive eq true` is part of every query filter and is not a setting, although Prompt 7 asks
for all retrieval settings to be configurable: its explicit rule that inactive content must not
be retrieved takes precedence.

## Azure OpenAI embeddings through REST, not the SDK (phase 8)

As for Azure AI Search, embeddings call the Azure OpenAI v1 REST endpoint with `fetch`. The
provider owns batching, input limits, throttling, retries and what may appear in logs and
errors (never input text or Azure's message, which can quote it), and tests run against an
in-process fake. Entra ID tokens come from `@azure/identity`.

## Embedding cache keyed by model, version, dimensions and text (phase 8)

Embeddings are cached by SHA-256 of model identifier, `EMBEDDING_VERSION`, dimensions and the
normalised text's hash, so unchanged chunks are not re-embedded while a model or version change
always regenerates. The index also records model, version, dimensions and time per chunk
(schema version 2) for phase 11's change detection. Chunks are embedded with their resource and
heading path prepended, because short chunks otherwise lose the context that makes them
findable.

## Answers are refused rather than repaired by the support checker (phase 9)

When the model's answer contains a claim with no cited source, the whole answer is replaced by
the insufficient-evidence message instead of dropping that claim: the remaining claims may only
make sense with the unsupported one. Links the passages do not contain are removed rather than
refusing the answer, because a link is not a claim. Invented source IDs make the output invalid
(one repair, then a safe failure), since they mean the model cited something it was not given.

## The embedding deployment variable switches query embeddings on (phase 9)

`AZURE_OPENAI_ENDPOINT` and the API key are shared by the chat and embedding deployments, so
their presence does not mean embeddings are configured. Retrieval uses query embeddings when
`AZURE_OPENAI_EMBEDDING_DEPLOYMENT` is set; `pnpm api ask` requires them because answers always
use hybrid retrieval.

## Unsupported claims are removed, not the whole answer (phase 10)

Prompt 10 replaces the phase 9 rule (any unsupported claim refused the answer). Unsupported
claims are removed when at least as many claims survive as are removed; otherwise the answer is
refused. When anything was removed, the shown text is rebuilt from the surviving claims rather
than the model's prose, because the prose may still state the removed content. Claim checks are
mechanical (references, numbers, shared words): they catch fabricated pages, links, documents and
figures, not subtle paraphrase errors, which the evaluation set and live testing must cover.
