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

## Synchronisation state behind a repository interface (phase 11)

Jobs read and write state only through `SyncStateRepository`. Conditional writes (revision) and
leases are part of the interface, because they are what make jobs safe to overlap, and they map
directly onto SQL row versions and Azure Table ETags. The local implementation is JSON files with
lock files; a production store is chosen in phase 19 and must pass the same contract tests.

## Hidden Moodle content is excluded by default (phase 11)

Hidden courses, sections, activities and Book chapters are not indexed unless
`SYNC_INCLUDE_HIDDEN=true`, and are removed when they become hidden. Hidden content is usually a
draft or retired material, and until enrolment checks (phase 14) anything indexed is answerable
to everyone authorised for the course.

## Deletions are guarded and selected courses are never auto-removed (phase 11)

A Moodle glitch or a permission change on the service account can make a course look empty or
missing. Removing more than half of a course's indexed resources (above a small minimum) needs
`--allow-mass-delete`, and a selected course Moodle does not return is reported, not removed.
The cost: genuinely deleted content in a still-selected course stays until an operator acts.

## Chunks are kept on transient failures, removed on permanent failures of new files (phase 11)

An outage must not make content unanswerable, so a transient failure keeps the indexed version.
A permanent failure on a changed file removes the old chunks, because they describe a file
Moodle no longer serves and would otherwise answer from an outdated version indefinitely.

## An HTTP answer API between Teams and the answer engine (phase 12)

Prompt 12 says the Teams app calls "the existing RAG API", but until now the engine was only
reachable through the CLI. Phase 12 adds `pnpm api serve` rather than embedding the engine in
the bot: the bot then needs no Moodle, Search or OpenAI credentials, the API is the single place
that will verify user tokens (phase 13) and enforce course access (phase 14), and the two can be
scaled and secured separately. The request/response contract lives in `@ehub/shared/answers`.

## Microsoft Teams SDK behind an adapter (phase 12)

The bot uses `@microsoft/teams.apps` (Microsoft Teams SDK v2), which Microsoft lists as the main
toolkit for Teams agents. Only `src/teams/` imports it; the conversation, API client and card
renderers are SDK-free. The SDK's own logger is replaced by one that keeps only message strings,
because the SDK logs whole activities (including the user's question) at debug level. The SDK's
express transport is replaced by a small node:http adapter that also serves `/health`.

## Answer in the background, acknowledge at once (phase 12)

Teams redelivers an activity whose HTTP response takes more than 15 seconds, and a grounded
answer can take longer. The bot replies to Teams immediately, shows "typing", answers in the
background and ignores redelivered activity IDs.

## Development mock identity, refused everywhere else (phase 12)

Teams message fields are not proof of identity for the API. Until SSO, both services accept an
explicit mock user only with `NODE_ENV=development`, the API decides that user's courses, every
card carries a "mock identity" banner, and both services (and production packaging) refuse to
run in production.

## The API validates Entra ID tokens itself; the bot forwards them unread (phase 13)

The bot obtains the user's token through Teams SSO (an Azure Bot OAuth connection) and passes
it on as `Authorization: Bearer`, without decoding it. Only the answer API decides who the
caller is, using `jose` against Entra's published keys: RS256 only, issuer bound to the token's
own tenant (Microsoft signs every tenant's tokens with the same keys, so a valid signature alone
proves nothing), audience, tenant and calling-app allowlists, the `access_as_user` scope, a user
(not app-only) token and a GUID object ID. The object ID, not the UPN or email, is the user key:
it is stable for guests, whose UPN is rewritten by Entra.

## Two app registrations: the bot is the client, the API is the resource (phase 13)

Teams SSO issues a token for the bot's own registration (`api://botid-<bot ID>`); the OAuth
connection exchanges it on behalf of the user for the API's `access_as_user` scope. A separate
API registration means the API accepts tokens only for itself, and further clients (for example
the administration UI in phase 15) can be allowed by ID without sharing the bot's identity.
The exchange to a custom scope is documented but not yet tested in the tenant (docs/entra-sso.md).

## Development switches turn off instead of failing outside development (phase 13)

Phase 12 refused to start when a mock or unauthenticated switch was set outside development. Now
that real identity exists, a stray switch in a test or staging environment is switched off with a
warning, and the service runs with real sign-in. Both outcomes are fail-closed; turning off is
less fragile for deployments that share variable sets. Production still refuses to start until
phase 14 limits users to their enrolled courses.

## Course authorisation comes from Moodle, before retrieval, and is cached briefly (phase 14)

The API maps each validated Entra user to one Moodle account and uses that account's active
enrolments in visible courses as the course filter inside the search request. It never asks the
model and never filters results afterwards; the search client's check that every hit lies in the
set is a second line, not the control. Results are cached (5 minutes by default) because each
question would otherwise cost two Moodle calls. Revocation is by TTL, explicit invalidation and
a scheduled enrolment sync. A stale grant during a Moodle outage is off by default: an outage
refuses questions rather than answering from an old view.

## Identity mapping: explicit, then unique email, then an opt-in UPN rule; ambiguity is denied (phase 14)

Explicit administrator mappings come first and, if they fail, nothing else is tried, so a
mapping cannot silently fall through to a different account. Email matching is accepted because
only Skin Renewal's tenant is trusted and its email values are set by administrators or by guest
invitation, not by users. It must match exactly one active Moodle account. Guests (branch staff
on personal addresses) can only be matched by email or an explicit mapping; their UPNs are
never treated as usernames.

## No separate allowed-courses field in the index (phase 14)

Prompt 14 asks for allowed-course metadata on indexed content. Every chunk already carries a
filterable `courseId` from Moodle, and each chunk belongs to exactly one course, so the filter
uses it directly. A second `allowedCourseIds` field would hold the same value. Existing chunks
would lack it until the whole corpus is re-chunked and re-embedded (the sync sees no change in
source files), and a filter on it would hide all current content until then. A real need for it
would be content shared across courses, which Moodle enrolments do not express.

## Production gates replaced by configuration requirements (phase 14)

The blanket production refusals in the API, the bot and `teams:package` existed because there
was no real identity (phase 13) and no course authorisation (phase 14). They are replaced by
checks that production has Entra sign-in and Moodle authorisation (API) and bot credentials and
SSO (bot). Security hardening (phase 17) and the Azure deployment (phase 19) are still to come.

## Administration inside the answer API, signed in with MSAL and bearer tokens (phase 15)

The administration area is a static page and a JSON API under `/admin` in the answer API, not a
separate app: it reuses the API's Entra validation, identity store and authorisation cache, and
there is no second service to deploy and secure. The page signs in through its own SPA
registration with MSAL and calls the API with bearer tokens. With no session cookie there is no
cookie-based CSRF to defend; a server-side session would have needed a confidential client, a
session store and CSRF tokens for no gain. Manual sync jobs run in the API process, one at a
time, guarded by the same course leases as the scheduled indexer, because there is no job queue
yet (phase 19 adds scheduled jobs in Azure).

## Configuration is shown, not edited, in the administration area (phase 15)

Settings come from the environment and Key Vault references. Editing them from a page would
make the running configuration differ from the deployed one, need write access to secrets'
neighbours, and bypass change control. The page shows an allow-list of non-secret values;
changes go through the app settings.

## No four-eyes approval for identity overrides (phase 15)

An override is approved by one application administrator, with a confirmation, a Moodle check
that the account is active, and an audit record. Two-person approval was considered and left
out: Skin Renewal has one IT administrator, so it would block every override.

## Telemetry through a process-wide registry (phase 16)

Components reach telemetry with `getTelemetry()`, configured once at start-up, rather than by
constructor injection. Tracing and metrics touch the Moodle client, search, embeddings, the chat
model, the indexer pipeline, authentication, authorisation and the admin area. Injecting it
would change dozens of established constructors and option types for a cross-cutting concern.
OpenTelemetry itself uses a global API for the same reason. It is still an interface (`Telemetry`)
with a no-op default, an in-memory implementation that applies the production rules for tests,
and an OpenTelemetry implementation.

## Explicit spans; automatic instrumentation off (phase 16)

Azure Monitor's distribution instruments outbound HTTP automatically, and that span records the
full URL. Moodle file downloads carry the web-service token in the query string, so automatic
HTTP spans would export the token. The SDK has no reliable hook to rewrite a span's attributes
before export, so redaction after the fact is not an option. Every automatic instrumentation is
off; the services create explicit spans whose names, attributes and metric dimensions are
allow-listed (`telemetry/catalogue.ts`). The cost is that a new dependency needs its own span.

## Rejected tokens are not span errors (phase 16)

A refused token is recorded as an outcome and reason on `auth.validate` and counted in
`ehub.auth.events`, not as a failed span. Application Insights counts failed spans in its
failure rates, and a burst of bad tokens would look like an outage. The authentication-anomaly
alert reads the counter instead. Signing keys that cannot be fetched are an error.

## Readiness probes the chat model with a real completion (phase 16)

The chat deployment has no cheap health endpoint, so readiness sends a fixed 16-token prompt.
Results are cached for 30 seconds, so a load balancer probing every few seconds causes at
most about 2,900 completions a day per API instance. Each is about 30 input tokens and a few
output tokens: roughly US$0.10–0.30 a day at GPT-4o list prices. This is an estimate, not checked
against Skin Renewal's deployment or contract pricing. The alternative was to report the model
as up without checking, which would leave a broken key or deleted deployment invisible until
staff asked a question.

## Fixed-ratio sampling, not the distribution's default (phase 16)

Azure Monitor's distribution (1.20.1) defaults to a rate-limited sampler of 5 traces a second.
That sampler takes precedence over `samplingRatio`, adapts from zero at start-up, and in testing
dropped the first spans of a process. At Skin Renewal's volume it would discard a varying share
of traces, and with it the evidence for the alerts. `tracesPerSecond: 0` selects the fixed-ratio
sampler; `samplingRatio: 1` keeps everything. This was found by running the real distribution
(`tests/integration/azure-monitor-instrumentation.test.ts`), not from its documentation.

## Azure Container Apps, one image, scheduled jobs (phase 19)

The API and the bot run as Container Apps; sync, enrolment refresh and reconciliation run as
scheduled Container Apps jobs. All of them use one image, `ehub:<commit>`, with different
commands, so a release is one build and a rollback is one tag. App Service was the alternative.
Container Apps gives revision history for rollback, native scheduled jobs, managed-identity image
pulls and Key Vault references, and scales the jobs to zero between runs. Images are built with
`az acr build`, so deploying needs no local Docker.

## Two deployment stages (phase 19)

Each identity reads only the Key Vault secrets it needs, by a role assignment on the secret.
Such an assignment needs the secret to exist, and the services need the image and secrets to
start. So stage 1 creates everything else, the operator adds the Moodle token and bot secret,
and stage 2 deploys the services. Granting access to the whole vault would allow one stage, but
would let the bot read the Moodle token.

## The file-based state stores, on Azure Files, for the pilot only (phase 19)

The only state store implementations are the JSON-file stores from phases 11–15, so the
deployment mounts them from an Azure Files share. They need one API replica, and locking over
SMB is not verified. They also force shared-key access on the storage account, because
Container Apps mounts Azure Files only with the account key. This is acceptable for a pilot, not
for production with all staff. Before production, implement the database stores (docs/sync.md
has the layout) and let the API scale out.

## Platform probes on /health/live, readiness monitored separately (phase 19)

With one replica sharing Moodle, Search and the model with nothing else, a failing readiness
probe only takes the service offline, admin page included. Container Apps therefore probes
`/health/live`, and an availability test alerts on `/health/ready`. This corrects the Phase 16
advice to use `/health/ready` as the readiness probe, which holds only with several replicas
behind a load balancer.

## Bot SSO connection by script, not Bicep (phase 19)

The Azure Bot OAuth connection needs the Entra ID provider's identifier and parameter names,
which the template reference does not document. `configure-bot-sso` reads them from
`az bot authsetting list-providers` at run time and stops if it cannot find them, rather than
deploying a guessed GUID.

## Test runs with NODE_ENV=production (phase 19)

The test environment uses real Entra sign-in and production configuration rules. Problems that
only production rules catch then show up in the pilot, not after go-live. Its differences from
production are sizes and protections (locks, purge protection, retention), not behaviour.

## Abuse limits in the API, keyed by the validated user (phase 17)

Rate limits (questions and feedback per user) and the cap on concurrent answers are checked in
the API after token validation and before the body is parsed or Moodle is asked. Keying by the
Entra object ID means a caller cannot dodge a limit by changing anything they send. Checking
before any work makes a refused request nearly free. The limits are in memory: right for the
single API replica, and to be moved to a shared store with the database state store.

## No cross-origin access instead of a CORS allowlist (phase 17)

Prompt 17 asks for a CORS allowlist. Nothing needs cross-origin access: the bot calls the API
server-to-server, and the admin page is served from the API's own origin. So the API sends no
Access-Control-Allow-* headers and refuses preflight requests. An allowlist with no entries
would be the same thing, with code that could be misconfigured. A future browser client on
another origin would add an explicit allowlist.

## A skipped security test fails the security report (phase 17)

`pnpm test:security` reports a control as passed only when every test listed for it ran and
passed. A skipped test (the Bicep or PowerShell checks, when those tools are missing) makes the
control incomplete, which fails the run. A report that says "pass" for a check that never ran
would be worse than one that fails and says why.

## Acceptance suites answer through a quoting model, not a scripted one (phase 18)

The acceptance stack runs the real indexing pipeline and the real answer engine over one fake
search service, and its chat model answers by quoting the passages the prompt gave it. A model
with hand-written replies would test the engine against text chosen to pass; quoting makes an
answer a window onto the index, so a content change shows as an answer change and a removed
passage cannot be quoted. The cost is that nothing here predicts how a real model phrases an
answer, which is what `pnpm evaluation:full` measures against a deployment.

## Grounding is mechanical, and suite 09 says so in a test (phase 18)

`ClaimSupportValidator` catches claims with no valid citation, invented pages, slides, documents
and links, numbers that appear in no source, and claims with no overlap with the passage they
cite. It does not judge meaning: a claim that cites a real passage and reuses its words can
contradict it and still pass. Suite 09 records that limitation as a test rather than a sentence
in a document, so it cannot be mistaken for a check that exists. Reading answers against the
source stays a pilot activity.

## A skipped acceptance suite fails the acceptance report (phase 18)

As with the security report, a suite passes only when every file listed in
`tests/acceptance/suites.json` produced results and every test in it passed; a skipped test
makes the suite incomplete, which fails the run. The catalogue is also tested against the
directory, so a new `tests/acceptance/NN-*.test.ts` that nobody listed fails rather than going
unreported. Suites needing a live Moodle, Azure or Teams are reported as not-run with the
command to run them, and never affect the exit code.
