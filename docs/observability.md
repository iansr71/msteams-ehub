# Monitoring and observability

The API, the Teams bot and the indexer emit OpenTelemetry traces and metrics. With
`APPLICATIONINSIGHTS_CONNECTION_STRING` set they go to Application Insights through Azure
Monitor's OpenTelemetry distribution (`@azure/monitor-opentelemetry`). Without it, telemetry
is a no-op and only the JSON logs are written.

Each process also logs `correlationId` (one per Teams turn, HTTP request or job) and, while a span
is active, `traceId`, so a log line can be matched to its trace.

## What is never recorded

Telemetry follows the same rule as the logs: no credentials, tokens, authorisation headers,
cookies, keys, questions, answers, source text, email addresses, user names, Entra object IDs or
URLs. This is enforced in code rather than by convention:

- **Fixed names.** Every span and metric name is in `packages/shared/src/telemetry/catalogue.ts`;
  the types do not accept any other.
- **Allow-listed dimensions and attributes.** Each metric declares its dimensions, and each has
  a rule: a fixed set of values, or a _code_ (`^[a-z][a-z0-9_.]{0,47}$`, so no `@`, `/`, `:`,
  spaces or capitals). Span attributes are allow-listed the same way. Integers are allowed for
  counts, course IDs and HTTP status. Identifiers are allowed only for correlation, job and
  answer IDs, which identify a request, not a person. Anything else is dropped and counted in
  `ehub.telemetry.dropped`, which should stay at zero.
- **No exception recording.** A failed span carries `ERROR` status and a category code
  (`timeout`, `authentication`, `rate_limit` and so on). It never carries the exception or its
  message: error messages can contain URLs, Moodle tokens or user input.
- **No automatic instrumentation.** The distribution's HTTP, Azure SDK, database and logging
  instrumentations are switched off (`AZURE_MONITOR_OPTIONS` in `startTelemetry.ts`). The HTTP
  instrumentation would record full outbound URLs, and Moodle file downloads carry the
  web-service token in the query string. The services create explicit spans instead.
- **No process resource detector.** It would add `process.command_args` to every span, and CLI
  arguments carry questions (`pnpm api ask --question`) and email addresses
  (`pnpm identity resolve --email`). `OTEL_NODE_RESOURCE_DETECTORS` is rewritten at start-up to
  drop `process` (and to expand `all` without it), with a warning.
- **Live Metrics are off.** Live Metrics streams request and dependency details outside the
  normal pipeline.
- **The connection string is a secret.** It is registered with the log redactor at start-up.

`tests/integration/azure-monitor-instrumentation.test.ts` runs the real distribution with these
options in a child process. It makes outbound `http` and `fetch` calls whose URLs carry a token,
and checks that no automatic span is recorded while explicit spans and metrics are exported. A
control run with HTTP instrumentation on must show the token, which proves the check would catch
a leak after a distribution upgrade.

`tests/security/telemetry-redaction.test.ts` runs the answer API against the real OpenTelemetry
SDK, sending bearer tokens, a forged token, Basic credentials, cookies, API-key headers, a
question naming a client, and an answer built from source text. It checks that none of them
appear in any exported span (attributes, status, events, links, resource), metric or log line,
and that the request path was actually recorded.

## Traces

| Span                    | Kind     | Where                                  | Notable attributes                                  |
| ----------------------- | -------- | -------------------------------------- | --------------------------------------------------- |
| `teams.activity`        | server   | Bot, each Bot Framework request        | `http.response.status_code`                         |
| `answer_api.request`    | client   | Bot → answer API                       | Propagates W3C `traceparent`                        |
| `api.request`           | server   | API, each HTTP request                 | `ehub.route` (`answers`, `health`…), status code    |
| `auth.validate`         | internal | API, Entra token validation            | `ehub.outcome`, `ehub.reason` (rejection code)      |
| `identity.resolve`      | internal | API, Entra → Moodle identity           | `ehub.outcome`, `ehub.method`, `ehub.reason`        |
| `authorization.courses` | internal | API, authorised courses                | `ehub.source` (`cache`, `stale`, `moodle`), count   |
| `search.query`          | client   | Azure AI Search query                  | `ehub.count.courses`, `ehub.count.results`          |
| `embedding.request`     | client   | Azure OpenAI embeddings, per batch     | `ehub.count.inputs`                                 |
| `model.generate`        | client   | Azure OpenAI chat completion           |                                                     |
| `citation.validate`     | internal | Citation and claim validation          | `ehub.count.citations`, `ehub.count.removed_claims` |
| `moodle.request`        | client   | Moodle web-service call                | `ehub.operation` = Moodle function name             |
| `moodle.download`       | client   | Moodle file download                   | `ehub.count.bytes`                                  |
| `pipeline.extract`      | internal | Indexer, extraction of one resource    | `ehub.stage`                                        |
| `pipeline.chunk`        | internal | Indexer, chunking                      | `ehub.stage`                                        |
| `pipeline.embed`        | internal | Indexer, embedding a resource's chunks | `ehub.stage`                                        |
| `pipeline.index`        | internal | Indexer, replacing a resource's chunks | `ehub.stage`                                        |
| `search.index`          | client   | Azure AI Search upload or delete       | `ehub.operation` (`index`, `delete`)                |
| `sync.job`              | internal | Indexer or admin job                   | `ehub.job_type`, `ehub.job_id`, `ehub.status`       |
| `admin.action`          | internal | Administration mutation                | `ehub.action`, `ehub.status`, `ehub.reason`         |
| `health.check`          | internal | Readiness probe of one dependency      | `ehub.dependency`                                   |

Every span also carries `ehub.correlation_id`.

In Application Insights, server spans become **requests** and client spans **dependencies**. A
question from Teams is one end-to-end transaction: the bot's `teams.activity` and
`answer_api.request`, then the API's `api.request` with its children. The bot injects
`traceparent`; the API continues that trace and accepts only `traceparent` and `tracestate`
values up to 512 characters.

A rejected token is recorded on `auth.validate` as `ehub.outcome = failure` with the rejection
reason. It is not a span error: a correct refusal is the service working, and marking it as an
error would inflate the failure rate. Rejections are counted in `ehub.auth.events`. Signing keys
that cannot be fetched (`keys_unavailable`) _are_ an error.

## Metrics

| Metric                              | Type      | Dimensions                            |
| ----------------------------------- | --------- | ------------------------------------- |
| `ehub.http.server.duration`         | histogram | `service`, `route`, `status_class`    |
| `ehub.dependency.duration`          | histogram | `dependency`, `operation`, `outcome`  |
| `ehub.dependency.failures`          | counter   | `dependency`, `operation`, `category` |
| `ehub.pipeline.duration`            | histogram | `stage`, `outcome`                    |
| `ehub.pipeline.failures`            | counter   | `stage`, `category`                   |
| `ehub.answers`                      | counter   | `status`                              |
| `ehub.citation_validation.failures` | counter   | `reason`                              |
| `ehub.access.denials`               | counter   | `kind`, `reason`                      |
| `ehub.auth.events`                  | counter   | `outcome`, `reason`                   |
| `ehub.identity.mappings`            | counter   | `status`, `method`, `reason`          |
| `ehub.rate_limit.events`            | counter   | `dependency`                          |
| `ehub.sync.jobs`                    | counter   | `job_type`, `status`                  |
| `ehub.sync.lag`                     | gauge (s) | none                                  |
| `ehub.sync.resources`               | gauge     | `status`                              |
| `ehub.admin.actions`                | counter   | `action`, `status`                    |
| `ehub.telemetry.dropped`            | counter   | `kind`                                |

Values:

- `dependency`: `moodle`, `moodle_download`, `search`, `embedding`, `chat`, `entra_keys`,
  `state_store`, `answer_api`.
- `stage`: `download`, `extraction`, `chunking`, `embedding`, `indexing`.
- `ehub.answers` `status`: `answered`, `insufficient_evidence`, `failed`.
- `ehub.citation_validation.failures` `reason`:
  - `claim_removed`: counted per removed claim; some claims had no valid source and were dropped.
  - `answer_refused`: the model gave an answer but no claim survived validation.
  - `invariant_violation`: an answer reached the end without a valid source. It is replaced
    with the refusal message and should never happen.
- `ehub.access.denials` `kind`:
  - `unauthenticated`, `forbidden`: the token was refused.
  - `identity_not_mapped`: no Moodle account could be confirmed.
  - `no_authorized_courses`, `course_not_authorized`: course access was refused.
  - `admin_forbidden`: an administration role was missing; `reason` names the permission.
  - `bot_request_unauthenticated`: the Bot Framework token was refused by the bot.
- `ehub.sync.jobs` `status`: `succeeded`, `completed_with_failures`, `failed`. Dry runs are not
  counted.
- `ehub.sync.lag`: seconds since the last successful, non-dry-run sync job finished. It is
  reported after each job, and every 5 minutes by the API when the administration area is
  enabled. It is not reported until a job has succeeded.
- `ehub.sync.resources` `status`: the count of resources in each sync state (`indexed`, `failed`,
  `dead_letter`, `quarantined`, `excluded`, `removed`).

Standard Application Insights metrics (request and dependency rates and durations) are derived
from the spans as well.

## Health endpoints

| Endpoint            | Service  | Meaning                                                                                                                                              |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | API, bot | The process serves HTTP. Never checks anything external, so a Moodle or Azure outage does not restart the service. Use it as the **liveness** probe. |
| `GET /health/ready` | API      | Every required dependency answered. `503` otherwise, or when no identity provider is configured. Use it as the **readiness** probe.                  |
| `GET /health/ready` | bot      | The answer API's `/health/live` answered within 3 s (cached 15 s), and SSO is configured.                                                            |
| `GET /health`       | API, bot | The existing summary: service, version, identity mode. Unchanged.                                                                                    |

The API's readiness checks are listed below. Results are cached for 30 seconds, and each probe
times out after 5 seconds. The response lists each dependency with its status (`up`, `down`,
`not_configured`), latency and a failure category, never an error message or endpoint.

| Dependency    | Required                                      | Probe                                                                 |
| ------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| `search`      | always                                        | The search client's health check; `degraded` counts as up (see below) |
| `embedding`   | always                                        | The embedding deployment's health check                               |
| `chat`        | always                                        | A 16-token completion of a fixed prompt                               |
| `moodle`      | when Moodle authorisation is configured       | `core_webservice_get_site_info`                                       |
| `state_store` | with authorisation or the administration area | Reads the identity store and the sync state                           |

Search reports `degraded` when the credential cannot read service statistics. A data-plane-only
identity, which is the least-privilege choice for the API, is reported that way. It also reports
`degraded` when the index has pending compatible schema changes. Both still serve queries, so
neither makes the API not ready.

A required dependency without a probe counts as not ready, so a misconfiguration fails closed.

### `pnpm diagnose`

`pnpm diagnose` (also `pnpm api diagnose`) runs the configuration checks, then every live probe
without the cache, then reads the sync state for lag and resource counts. It prints JSON with
names, statuses, categories and timings only, never values, endpoints or credentials. It exits 1
when configuration fails, live checks could not run, the sync state is unreadable, or a required
dependency is down. It also reports whether the Application Insights connection string is
`configured`, `not_configured` or `invalid`.

## Setting up Application Insights

1. Create a workspace-based Application Insights resource (phase 19 does this in Bicep).
2. Set `APPLICATIONINSIGHTS_CONNECTION_STRING` for the API, the bot and the indexer: a Key Vault
   reference in Azure, or `.env` locally. Each sets its own `service.name` (`ehub-api`,
   `ehub-teams-app`, `ehub-indexer`), which becomes the cloud role name.
3. Check it with `pnpm diagnose` (`telemetry.applicationInsights: "configured"`). An invalid value
   is reported by name and telemetry stays off: monitoring never stops a service from starting.
4. Every trace is kept. The distribution's default is a rate-limited sampler (5 traces a
   second), which takes precedence over `samplingRatio` and drops a varying share of traces at
   low volume, short CLI runs included. `AZURE_MONITOR_OPTIONS` sets `tracesPerSecond: 0` to
   select the fixed-ratio sampler, with `samplingRatio: 1`. At Skin Renewal's volume (about 90
   branch staff plus head office) the ingestion cost is small; lower `samplingRatio` if that
   changes.

Commands flush telemetry before they exit; the API and bot flush on shutdown.

## Recommended alerts

These are log search alert rules over the `customMetrics` table, where OpenTelemetry metrics
arrive with their dimensions in `customDimensions`. For counters, `valueSum` is the count in each
export interval; for histograms, `valueCount` is the number of observations. Thresholds are
starting points for Skin Renewal's volume. Tune them after a few weeks of real traffic.

> **Not yet verified against a live workspace.** The table and column mapping is as Azure
> Monitor documents it for OpenTelemetry metrics, but these queries have not been run against
> real data from this app. Check each one in Logs before saving it as a rule (phase 19/20).

### 1. Repeated sync failure (severity 2)

Two or more failed sync jobs in six hours: a credential, Moodle or search problem that retries
will not fix.

```kusto
customMetrics
| where timestamp > ago(6h) and name == "ehub.sync.jobs"
| where tostring(customDimensions["status"]) == "failed"
| summarize failures = sum(valueSum)
| where failures >= 2
```

Evaluate every 30 minutes. Investigate on the administration area's Jobs page, or rerun with
`pnpm indexer sync:incremental` to see the report.

### 2. High extraction failure rate (severity 3)

More than 20 % of resources failing extraction over a day, with at least 10 attempts. This
usually means a new file type or a batch of scanned or encrypted PDFs.

```kusto
let window = 24h;
let attempts = customMetrics
  | where timestamp > ago(window) and name == "ehub.pipeline.duration"
  | where tostring(customDimensions["stage"]) == "extraction"
  | summarize n = sum(valueCount);
let failures = customMetrics
  | where timestamp > ago(window) and name == "ehub.pipeline.failures"
  | where tostring(customDimensions["stage"]) == "extraction"
  | summarize f = sum(valueSum);
attempts | extend f = toscalar(failures)
| where n >= 10 and f / n > 0.2
| project attempts = n, failures = f, rate = round(f / n, 3)
```

Evaluate every 6 hours. The Failures page groups them by category.

### 3. Sustained search failure (severity 1)

More than 25 % of search calls failing for 15 minutes, with at least 10 calls. Staff get no
answers while this lasts.

```kusto
customMetrics
| where timestamp > ago(15m) and name == "ehub.dependency.duration"
| where tostring(customDimensions["dependency"]) == "search"
| summarize total = sum(valueCount),
            failed = sumif(valueCount, tostring(customDimensions["outcome"]) == "failure")
| where total >= 10 and failed / total > 0.25
```

Evaluate every 5 minutes and alert after 3 consecutive breaches. Pair it with an availability
test on the API's `/health/ready`, which also catches search being down when nobody is asking
questions.

### 4. Model failure (severity 1 for authentication, 2 otherwise)

Five or more failed chat completions in 15 minutes. Split by category: `authentication` or
`authorization` means the key or managed identity broke; `throttled` means the deployment's
quota is too low; `content_filter` is worth reading separately.

```kusto
customMetrics
| where timestamp > ago(15m) and name == "ehub.dependency.failures"
| where tostring(customDimensions["dependency"]) == "chat"
| summarize failures = sum(valueSum) by category = tostring(customDimensions["category"])
| where failures >= 5 or (category in ("authentication", "authorization") and failures >= 1)
```

Evaluate every 5 minutes. Also watch `ehub.rate_limit.events` with `dependency == "chat"`.

### 5. Citation-validation failure (severity 1 for invariant violations, 3 for refusals)

Any `invariant_violation` is a defect: an answer reached the end without a valid source. It was
replaced with the refusal message, but the cause must be found. A refusal rate above 15 % of
answers over a day suggests a prompt or model regression.

```kusto
let window = 24h;
let answers = toscalar(customMetrics
  | where timestamp > ago(window) and name == "ehub.answers"
  | summarize sum(valueSum));
customMetrics
| where timestamp > ago(window) and name == "ehub.citation_validation.failures"
| summarize n = sum(valueSum) by reason = tostring(customDimensions["reason"])
| where (reason == "invariant_violation" and n >= 1)
     or (reason == "answer_refused" and answers >= 20 and n / answers > 0.15)
```

Evaluate hourly. `pnpm evaluation answers --file <cases.json>` reproduces it offline.

### 6. Authentication anomaly (severity 2)

A burst of rejected tokens: more than 20 in 15 minutes and more than three times the usual rate
for that hour over the past week. Any `keys_unavailable` means Entra's signing keys cannot be
fetched, and every request will fail.

```kusto
let recent = customMetrics
  | where timestamp > ago(15m) and name == "ehub.auth.events"
  | where tostring(customDimensions["outcome"]) == "failure"
  | summarize n = sum(valueSum) by reason = tostring(customDimensions["reason"]);
let baseline = toscalar(customMetrics
  | where timestamp between (ago(7d) .. ago(15m)) and name == "ehub.auth.events"
  | where tostring(customDimensions["outcome"]) == "failure"
  | summarize sum(valueSum) / (7.0 * 24 * 4));
recent
| summarize total = sum(n), keysUnavailable = sumif(n, reason == "keys_unavailable"),
            reasons = make_bag(bag_pack(reason, n))
| where keysUnavailable > 0 or (total > 20 and total > 3 * baseline)
```

Evaluate every 15 minutes. `invalid_audience`, `client_not_allowed` or `tenant_not_allowed`
point at a misconfigured client; `token_expired` in bulk points at clock skew. Because Skin
Renewal has no Entra P1, there is no Conditional Access or risky sign-in report to fall back on,
so this alert matters more than usual.

### 7. Excessive authorisation denial (severity 3)

More than 10 identity or course denials in an hour. With about 90 branch staff signing in as
guests on personal email addresses, `identity_not_mapped` is the common one: their Entra email
does not match a Moodle account and needs an override in the administration area.

```kusto
customMetrics
| where timestamp > ago(1h) and name == "ehub.access.denials"
| extend kind = tostring(customDimensions["kind"])
| where kind in ("identity_not_mapped", "no_authorized_courses", "course_not_authorized")
| summarize denials = sum(valueSum) by kind
| where denials > 10
```

Evaluate hourly. `pnpm identity failures` lists the unmapped users. A separate rule on
`kind == "admin_forbidden"` with any occurrence (severity 3) shows someone trying administration
without the role.

### 8. Stale index (severity 2)

The last successful sync finished more than 26 hours ago, which allows a daily schedule plus
margin; adjust it to the schedule phase 19 sets. A stalled scheduler reports no lag at all, so
missing data also alerts.

```kusto
customMetrics
| where timestamp > ago(26h) and name == "ehub.sync.lag"
| summarize arg_max(timestamp, value)
| project lagSeconds = value
| union (print lagSeconds = real(null))
| summarize lag = max(lagSeconds)
| where isnull(lag) or lag > 26 * 3600
```

Evaluate hourly. The query returns one row (and so alerts) both when the lag is too high and
when no lag was reported in 26 hours. `ehub.sync.resources` with `status == "dead_letter"`
growing is the slower version of the same problem.

## Local development

Leave `APPLICATIONINSIGHTS_CONNECTION_STRING` empty. Logs are JSON on stdout. `pnpm diagnose`
works locally against whatever is configured. Tests swap in `InMemoryTelemetry`, which applies
the same allow-list rules as production, or the real SDK with in-memory export
(`packages/shared/src/telemetry/__fixtures__/openTelemetrySdk.ts`).
