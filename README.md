# E-Hub Teams Knowledge Assistant

A Microsoft Teams personal app that answers staff questions from Moodle E-Hub course content.
Answers are grounded in indexed Moodle resources, carry validated citations, and respect each
user's Moodle course enrolments.

> **Status: phase 2 (Moodle REST client).** Shared foundation plus a typed, sanitized Moodle
> client and file downloader (`packages/moodle-client`). Course discovery, extraction,
> indexing, retrieval, answer generation and Teams behaviour are delivered in later phases.

## Repository layout

```
apps/
  api/            Question-answering API (retrieval, RAG, auth) — health command today
  indexer/        Moodle discovery, extraction, chunking and indexing — health command today
  teams-app/      Teams personal app (phase 12)
packages/
  shared/         Zod configuration, structured logger, redaction, correlation IDs, CLI/health helpers
  moodle-client/  Typed Moodle REST client and safe file downloader
infrastructure/
  bicep/          Azure infrastructure as code (phase 19)
tests/
  integration/    Cross-package tests (no real Azure or Moodle calls)
  security/       Security regression tests
  evaluation/     Retrieval and answer evaluation sets (phase 7 onwards)
docs/             Design and operational documentation
```

## Prerequisites

- Node.js **20.19 or later** (20 LTS, 22 or 24). `.nvmrc` pins the major version.
- pnpm **10** (`corepack enable` picks up the version in `package.json`).
- Docker with Compose v2 — only for the optional local dependencies.

## Installation

```bash
corepack enable
pnpm install
cp .env.example .env    # then fill in values locally; .env is git-ignored
```

`.env.example` lists variable **names only**. Never commit real values. Deployed environments
read configuration from Azure Key Vault references and app settings; the CLIs never load a
`.env` file when `NODE_ENV=production`.

## Commands

| Command                 | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `pnpm build`            | Compiles every package to `dist/` (TypeScript project builds) |
| `pnpm clean`            | Removes build output and coverage                             |
| `pnpm format`           | Formats the repository with Prettier                          |
| `pnpm format:check`     | Fails if any file is not formatted                            |
| `pnpm lint`             | ESLint (type-aware, zero warnings allowed)                    |
| `pnpm typecheck`        | Strict type check of all packages and tests                   |
| `pnpm test`             | All Vitest projects (unit, integration, security)             |
| `pnpm test:unit`        | Unit tests inside `packages/*` and `apps/*`                   |
| `pnpm test:integration` | Integration tests in `tests/integration`                      |
| `pnpm test:security`    | Security regression tests in `tests/security`                 |
| `pnpm api health`       | API configuration health report (JSON)                        |
| `pnpm indexer health`   | Indexer configuration health report (JSON)                    |

Validation gate used before every phase is committed:

```bash
pnpm install && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

### Health commands

```bash
pnpm -s indexer health     # -s hides pnpm's script banner so stdout is pure JSON
pnpm -s api health
```

The report lists each configuration group (`runtime`, `moodle`, `azureSearch`, `azureOpenAI`,
`azureIdentity`, `observability`) with `pass`, `warn` or `fail`. It shows variable **names** and
problems, never values. Exit codes: `0` healthy or warnings only, `1` a failed check, `2` usage
error. Logs go to stderr as JSON lines; stdout carries only the report.

Groups that later phases need are reported as `warn` while missing, so a fresh checkout is
healthy. A group that is partly configured or invalid is always `fail`.

After `pnpm build`, the same commands run without tsx: `node apps/indexer/dist/cli.js health`.

## Configuration

Validated with Zod in `packages/shared/src/config`. Empty values are treated as unset.

| Variable                                | Group         | Notes                                                  |
| --------------------------------------- | ------------- | ------------------------------------------------------ |
| `NODE_ENV`                              | runtime       | `development` (default), `test`, `production`          |
| `LOG_LEVEL`                             | runtime       | `trace` … `fatal`, `silent`; default `info`            |
| `PORT`                                  | runtime       | 1–65535; default `3000`                                |
| `MOODLE_BASE_URL`                       | moodle        | No credentials, query or fragment; https in production |
| `MOODLE_TOKEN`                          | moodle        | Secret                                                 |
| `MOODLE_REQUEST_TIMEOUT_MS`             | moodle        | Optional; 1000–300000, default 30000                   |
| `MOODLE_DOWNLOAD_TIMEOUT_MS`            | moodle        | Optional; 1000–1800000, default 120000                 |
| `MOODLE_MAX_DOWNLOAD_BYTES`             | moodle        | Optional; 1 KiB–2 GiB, default 100 MiB                 |
| `MOODLE_MAX_RETRIES`                    | moodle        | Optional; 0–10, default 3                              |
| `AZURE_SEARCH_ENDPOINT`                 | azureSearch   | https                                                  |
| `AZURE_SEARCH_INDEX_NAME`               | azureSearch   | Azure index naming rules                               |
| `AZURE_OPENAI_ENDPOINT`                 | azureOpenAI   | https                                                  |
| `AZURE_OPENAI_CHAT_DEPLOYMENT`          | azureOpenAI   | Deployment name                                        |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`     | azureOpenAI   | Deployment name                                        |
| `AZURE_TENANT_ID`                       | azureIdentity | GUID                                                   |
| `AZURE_CLIENT_ID`                       | azureIdentity | GUID                                                   |
| `AZURE_CLIENT_SECRET`                   | azureIdentity | Secret, optional — local development only              |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | observability | Secret, optional                                       |

In production every `*_URL` / `*_ENDPOINT` variable must use https.

## Logging, redaction and correlation

- `createLogger()` writes one JSON object per line with `time`, `level`, `service`,
  `correlationId` (when bound) and `msg`. Callers cannot overwrite those fields.
- Every record is redacted automatically: keys such as `authorization`, `cookie`, `token`,
  `accessToken`, `refreshToken`, `clientSecret`, `apiKey` and `MOODLE_TOKEN` (any case or
  separator, at any depth) are masked; `wstoken=`/`token=` query parameters, bearer tokens,
  JWTs and connection-string keys are scrubbed from strings; binary payloads are summarised by
  size; and the loaded secret values themselves are scrubbed wherever they appear.
- `runWithCorrelationId(id, fn)` binds an ID with `AsyncLocalStorage`; inbound IDs that are not
  short and log-safe are replaced with a generated UUID. CLI commands get a fresh ID per run.

## Local development dependencies

```bash
# requires LOCAL_POSTGRES_PASSWORD in .env
docker compose up -d
```

Starts PostgreSQL (candidate sync-state store) and Azurite (Azure Storage emulator), bound to
`127.0.0.1` only. Azure AI Search and Azure OpenAI are intentionally **not** simulated;
behaviour that depends on them is validated against real services in opt-in tests.

## Engineering rules

Strict TypeScript with no `any`; Zod for all external input; interfaces and dependency injection
around every external service; structured JSON logs with correlation IDs; no credentials or
document contents in logs; fail closed on authentication and authorisation; Moodle content is
untrusted data. See [`docs/decisions.md`](docs/decisions.md) for the foundation decisions and
[`docs/moodle-setup.md`](docs/moodle-setup.md) for the restricted Moodle web service.
