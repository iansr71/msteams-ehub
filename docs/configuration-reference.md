# Configuration reference

Every setting the assistant reads, where it comes from, and which of them you actually have to
decide. The tables below are generated from the Zod schemas with `pnpm config:reference`, so they
cannot drift from what the code accepts; `pnpm config:reference --check` fails if the committed
file is out of date.

`.env.example` is the same list in file form, with the grouping comments.

## Where values come from

| Environment           | Source                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A developer's machine | `.env` (not committed), read by every CLI at start-up.                                                                                                                                                                       |
| Azure (deployed)      | The container apps' environment, set by `infrastructure/bicep/main.bicep` from the `EHUB_*` parameters in `infrastructure/environments/<env>.env`.                                                                           |
| Secrets, in Azure     | Key Vault. Container Apps resolves each secret reference with the app's user-assigned managed identity and passes the value in the environment, so the application code never calls Key Vault and no person holds the value. |
| Release checks        | `infrastructure/environments/release.env` — the non-secret application settings only (docs/production-deployment.md).                                                                                                        |

Three secrets exist, and all three live in Key Vault: `moodle-token`,
`teams-bot-client-secret` and `appinsights-connection-string`. Azure AI Search and Azure OpenAI
are reached with managed identity in production, so their API-key variables stay unset.

## What you have to decide

Everything else has a working default. These do not:

| Variable                                                                                                            | What to put in it                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `MOODLE_BASE_URL`                                                                                                   | The E-Hub site's base URL, https.                                                        |
| `MOODLE_TOKEN`                                                                                                      | The service account's web-service token, in Key Vault (docs/moodle-production-setup.md). |
| `MOODLE_TOKEN_EXPIRES_ON`                                                                                           | The day that token expires, so the preflight can warn (docs/token-rotation.md).          |
| `SYNC_COURSE_IDS`                                                                                                   | The approved pilot courses, comma-separated.                                             |
| `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_INDEX_NAME`                                                                  | The deployed search service and index.                                                   |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_CHAT_DEPLOYMENT`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`                        | The model deployments.                                                                   |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`                                                                                | The tenant, and the managed identity's client ID.                                        |
| `ENTRA_API_CLIENT_ID`, `ENTRA_API_APP_ID_URI`, `ENTRA_ALLOWED_TENANT_IDS`, `ENTRA_ALLOWED_CLIENT_APP_IDS`           | The answer API's registration and who may call it (docs/entra-sso.md).                   |
| `TEAMS_BOT_CLIENT_ID`, `TEAMS_BOT_CLIENT_SECRET`, `TEAMS_BOT_TENANT_ID`, `TEAMS_SSO_RESOURCE`, `TEAMS_API_BASE_URL` | The bot and what it signs in against.                                                    |
| `TEAMS_APP_ID`, `TEAMS_DEVELOPER_NAME`, `TEAMS_WEBSITE_URL`, `TEAMS_PRIVACY_URL`, `TEAMS_TERMS_URL`                 | Manifest inputs, needed to build the package (docs/teams-deployment.md).                 |
| `TEAMS_ALLOWED_LINK_HOSTS`                                                                                          | The Moodle host, or citations lose their links.                                          |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`                                                                             | Telemetry, in Key Vault (docs/observability.md).                                         |

## Settings that must agree with each other

These are individually valid and still wrong together, which is why `pnpm preflight` checks them
as a group:

- `TEAMS_SSO_RESOURCE` is `ENTRA_API_APP_ID_URI`, optionally with `ENTRA_API_SCOPE` appended.
  Anything else and every sign-in fails as the wrong audience.
- `ENTRA_ALLOWED_CLIENT_APP_IDS` contains `TEAMS_BOT_CLIENT_ID`.
- `ENTRA_ALLOWED_TENANT_IDS` contains `TEAMS_BOT_TENANT_ID`.
- `ENTRA_API_CLIENT_ID` and `TEAMS_BOT_CLIENT_ID` are different registrations.
- `TEAMS_ALLOWED_LINK_HOSTS` contains the host of `MOODLE_BASE_URL`.
- `TEAMS_API_BASE_URL` is https in production.
- `ADMIN_SPA_CLIENT_ID` is set whenever `ADMIN_UI_ENABLED=true`.
- `AZURE_SEARCH_VECTOR_DIMENSIONS` matches `AZURE_OPENAI_EMBEDDING_DIMENSIONS`, and the deployed
  index's vector field (checked by `pnpm indexer embeddings:health`).

## Flags that are refused in production

`API_DEV_MOCK_IDENTITY`, `TEAMS_DEV_MOCK_IDENTITY`, `TEAMS_DEV_ALLOW_UNAUTHENTICATED` and
`API_DEV_MOCK_ROLES` exist for local development. In production the answer API refuses to start
while any of them is on, and the preflight fails.

## Variables

Required means the schema has no default and the feature fails to load without it; a feature is
only loaded by the commands that need it, so "required" is per feature, not per deployment.

<!-- generated: variables (pnpm config:reference) -->

### Runtime

| Variable    | Required | Default       | Notes |
| ----------- | -------- | ------------- | ----- |
| `LOG_LEVEL` | optional | `info`        |       |
| `NODE_ENV`  | optional | `development` |       |
| `PORT`      | optional | `3000`        |       |

### Moodle

| Variable                     | Required | Default     | Notes                                                               |
| ---------------------------- | -------- | ----------- | ------------------------------------------------------------------- |
| `MOODLE_BASE_URL`            | required | —           |                                                                     |
| `MOODLE_DOWNLOAD_TIMEOUT_MS` | optional | `120000`    |                                                                     |
| `MOODLE_MAX_DOWNLOAD_BYTES`  | optional | `104857600` |                                                                     |
| `MOODLE_MAX_RETRIES`         | optional | `3`         |                                                                     |
| `MOODLE_REQUEST_TIMEOUT_MS`  | optional | `30000`     |                                                                     |
| `MOODLE_TOKEN`               | required | —           | **secret** Key Vault secret `moodle-token`.                         |
| `MOODLE_TOKEN_EXPIRES_ON`    | optional | —           | Recorded expiry (YYYY-MM-DD); `pnpm preflight` warns 30 days ahead. |

### Extraction limits

| Variable                            | Required | Default     | Notes |
| ----------------------------------- | -------- | ----------- | ----- |
| `EXTRACTION_MAX_ARCHIVE_ENTRIES`    | optional | `2000`      |       |
| `EXTRACTION_MAX_INPUT_BYTES`        | optional | `52428800`  |       |
| `EXTRACTION_MAX_TEXT_CHARS`         | optional | `2000000`   |       |
| `EXTRACTION_MAX_UNCOMPRESSED_BYTES` | optional | `209715200` |       |
| `EXTRACTION_TIMEOUT_MS`             | optional | `60000`     |       |

### Chunking

| Variable               | Required | Default       | Notes |
| ---------------------- | -------- | ------------- | ----- |
| `CHUNK_MAX_TOKENS`     | optional | `1000`        |       |
| `CHUNK_MIN_TOKENS`     | optional | `100`         |       |
| `CHUNK_OVERLAP_TOKENS` | optional | `125`         |       |
| `CHUNK_TARGET_TOKENS`  | optional | `850`         |       |
| `CHUNK_TOKENIZER`      | optional | `cl100k_base` |       |

### Azure AI Search

| Variable                          | Required | Default                  | Notes                                                                                    |
| --------------------------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `AZURE_SEARCH_API_KEY`            | optional | —                        | **secret** Not used in production: the deployed service has key authentication disabled. |
| `AZURE_SEARCH_BATCH_SIZE`         | optional | `500`                    |                                                                                          |
| `AZURE_SEARCH_ENDPOINT`           | required | —                        |                                                                                          |
| `AZURE_SEARCH_INDEX_NAME`         | optional | `ehub-course-content-v1` |                                                                                          |
| `AZURE_SEARCH_MAX_RETRIES`        | optional | `3`                      |                                                                                          |
| `AZURE_SEARCH_REQUEST_TIMEOUT_MS` | optional | `30000`                  |                                                                                          |
| `AZURE_SEARCH_SEMANTIC_ENABLED`   | optional | `true`                   |                                                                                          |
| `AZURE_SEARCH_VECTOR_DIMENSIONS`  | optional | `1536`                   |                                                                                          |

### Azure OpenAI

| Variable                            | Required | Default | Notes |
| ----------------------------------- | -------- | ------- | ----- |
| `AZURE_OPENAI_CHAT_DEPLOYMENT`      | required | —       |       |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | required | —       |       |
| `AZURE_OPENAI_ENDPOINT`             | required | —       |       |

### Embeddings

| Variable                                 | Required | Default                         | Notes                                                        |
| ---------------------------------------- | -------- | ------------------------------- | ------------------------------------------------------------ |
| `AZURE_OPENAI_API_KEY`                   | optional | —                               | **secret** Not used in production: managed identity instead. |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`      | required | —                               |                                                              |
| `AZURE_OPENAI_EMBEDDING_DIMENSIONS`      | optional | `1536`                          |                                                              |
| `AZURE_OPENAI_EMBEDDING_MODEL`           | optional | `text-embedding-3-small`        |                                                              |
| `AZURE_OPENAI_EMBEDDING_SEND_DIMENSIONS` | optional | `false`                         |                                                              |
| `AZURE_OPENAI_ENDPOINT`                  | required | —                               |                                                              |
| `AZURE_OPENAI_TOKEN_SCOPE`               | optional | `https://ai.azure.com/.default` |                                                              |
| `EMBEDDING_BATCH_SIZE`                   | optional | `64`                            |                                                              |
| `EMBEDDING_CACHE_DIR`                    | optional | —                               |                                                              |
| `EMBEDDING_MAX_BATCH_TOKENS`             | optional | `100000`                        |                                                              |
| `EMBEDDING_MAX_CONCURRENCY`              | optional | `2`                             |                                                              |
| `EMBEDDING_MAX_INPUT_TOKENS`             | optional | `8191`                          |                                                              |
| `EMBEDDING_MAX_RETRIES`                  | optional | `4`                             |                                                              |
| `EMBEDDING_REQUESTS_PER_MINUTE`          | optional | `120`                           |                                                              |
| `EMBEDDING_REQUEST_TIMEOUT_MS`           | optional | `30000`                         |                                                              |
| `EMBEDDING_VERSION`                      | optional | `1`                             |                                                              |

### Retrieval

| Variable                            | Required | Default | Notes |
| ----------------------------------- | -------- | ------- | ----- |
| `RETRIEVAL_CANDIDATE_COUNT`         | optional | `24`    |       |
| `RETRIEVAL_MAX_CHUNKS_PER_RESOURCE` | optional | `3`     |       |
| `RETRIEVAL_MIN_RERANKER_SCORE`      | optional | —       |       |
| `RETRIEVAL_MIN_SCORE`               | optional | —       |       |
| `RETRIEVAL_SEMANTIC_RANKING`        | optional | `true`  |       |
| `RETRIEVAL_TOP_K`                   | optional | `8`     |       |

### Answer generation

| Variable                       | Required | Default                         | Notes                                                        |
| ------------------------------ | -------- | ------------------------------- | ------------------------------------------------------------ |
| `AZURE_OPENAI_API_KEY`         | optional | —                               | **secret** Not used in production: managed identity instead. |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` | required | —                               |                                                              |
| `AZURE_OPENAI_ENDPOINT`        | required | —                               |                                                              |
| `AZURE_OPENAI_TOKEN_SCOPE`     | optional | `https://ai.azure.com/.default` |                                                              |
| `CHAT_MAX_OUTPUT_TOKENS`       | optional | `1200`                          |                                                              |
| `CHAT_MAX_RETRIES`             | optional | `2`                             |                                                              |
| `CHAT_REQUEST_TIMEOUT_MS`      | optional | `60000`                         |                                                              |
| `CHAT_RESPONSE_FORMAT`         | optional | `json_schema`                   |                                                              |
| `CHAT_TEMPERATURE`             | optional | —                               |                                                              |
| `CITATION_ALLOWED_HOSTS`       | optional | —                               |                                                              |
| `CITATION_EXCERPT_CHARS`       | optional | `200`                           |                                                              |
| `RAG_MAX_ANSWER_CHARS`         | optional | `4000`                          |                                                              |
| `RAG_MAX_CONTEXT_TOKENS`       | optional | `12000`                         |                                                              |
| `RAG_MAX_QUESTION_CHARS`       | optional | `1000`                          |                                                              |
| `RAG_MIN_SUPPORTING_CHUNKS`    | optional | `1`                             |                                                              |
| `RAG_MIN_TOP_RERANKER_SCORE`   | optional | —                               |                                                              |

### Synchronisation

| Variable                   | Required | Default            | Notes                                                        |
| -------------------------- | -------- | ------------------ | ------------------------------------------------------------ |
| `AZURE_TENANT_ID`          | required | —                  |                                                              |
| `SYNC_ALL_COURSES`         | optional | `false`            | Must stay off in the pilot; the preflight fails if it is on. |
| `SYNC_COURSE_IDS`          | optional | —                  | The approved pilot courses.                                  |
| `SYNC_INCLUDE_HIDDEN`      | optional | `false`            |                                                              |
| `SYNC_LEASE_TTL_MS`        | optional | `1800000`          |                                                              |
| `SYNC_MAX_ATTEMPTS`        | optional | `5`                |                                                              |
| `SYNC_MAX_DELETE_FRACTION` | optional | `0.5`              |                                                              |
| `SYNC_MAX_DELETE_MINIMUM`  | optional | `5`                |                                                              |
| `SYNC_RETRY_BASE_DELAY_MS` | optional | `600000`           |                                                              |
| `SYNC_RETRY_MAX_DELAY_MS`  | optional | `86400000`         |                                                              |
| `SYNC_STATE_DIR`           | optional | `.ehub/sync-state` |                                                              |

### Answer API

| Variable                        | Required | Default         | Notes                                                                |
| ------------------------------- | -------- | --------------- | -------------------------------------------------------------------- |
| `API_DEV_ENTRA_COURSE_IDS`      | optional | —               |                                                                      |
| `API_DEV_MOCK_COURSE_IDS`       | optional | —               |                                                                      |
| `API_DEV_MOCK_IDENTITY`         | optional | `false`         | Development only; the API refuses to start with it on in production. |
| `API_DEV_MOCK_ROLES`            | optional | —               |                                                                      |
| `API_DEV_MOCK_USER_ID`          | optional | `dev-mock-user` |                                                                      |
| `API_HOST`                      | optional | `127.0.0.1`     |                                                                      |
| `API_MAX_CONCURRENT_ANSWERS`    | optional | `16`            |                                                                      |
| `API_RATE_LIMIT_FEEDBACK`       | optional | `60`            |                                                                      |
| `API_RATE_LIMIT_QUESTIONS`      | optional | `20`            |                                                                      |
| `API_RATE_LIMIT_WINDOW_SECONDS` | optional | `60`            |                                                                      |
| `API_REQUEST_TIMEOUT_MS`        | optional | `90000`         |                                                                      |

### Identity and course authorisation

| Variable                          | Required | Default                | Notes |
| --------------------------------- | -------- | ---------------------- | ----- |
| `AUTHZ_CACHE_MAX_ENTRIES`         | optional | `5000`                 |       |
| `AUTHZ_CACHE_TTL_SECONDS`         | optional | `300`                  |       |
| `AUTHZ_INVALIDATION_POLL_SECONDS` | optional | `5`                    |       |
| `AUTHZ_STALE_GRACE_SECONDS`       | optional | `0`                    |       |
| `IDENTITY_EMAIL_MATCHING`         | optional | `true`                 |       |
| `IDENTITY_STATE_DIR`              | optional | `.ehub/identity-state` |       |
| `IDENTITY_UPN_DOMAINS`            | optional | —                      |       |
| `IDENTITY_UPN_USERNAME_RULE`      | optional | `none`                 |       |

### Microsoft Entra ID

| Variable                        | Required | Default                             | Notes                               |
| ------------------------------- | -------- | ----------------------------------- | ----------------------------------- |
| `AZURE_TENANT_ID`               | required | —                                   |                                     |
| `ENTRA_ALLOWED_CLIENT_APP_IDS`  | required | —                                   | Must include `TEAMS_BOT_CLIENT_ID`. |
| `ENTRA_ALLOWED_TENANT_IDS`      | optional | —                                   |                                     |
| `ENTRA_API_APP_ID_URI`          | optional | —                                   |                                     |
| `ENTRA_API_CLIENT_ID`           | required | —                                   |                                     |
| `ENTRA_API_SCOPE`               | optional | `access_as_user`                    |                                     |
| `ENTRA_AUTHORITY_HOST`          | optional | `https://login.microsoftonline.com` |                                     |
| `ENTRA_CLOCK_TOLERANCE_SECONDS` | optional | `120`                               |                                     |

### Teams bot

| Variable                          | Required | Default         | Notes                                                             |
| --------------------------------- | -------- | --------------- | ----------------------------------------------------------------- |
| `TEAMS_ALLOWED_LINK_HOSTS`        | optional | —               | Must include the Moodle host, or citation links are not rendered. |
| `TEAMS_API_BASE_URL`              | optional | —               |                                                                   |
| `TEAMS_API_TIMEOUT_MS`            | optional | `60000`         |                                                                   |
| `TEAMS_BOT_CLIENT_ID`             | optional | —               |                                                                   |
| `TEAMS_BOT_CLIENT_SECRET`         | optional | —               | **secret** Key Vault secret `teams-bot-client-secret`.            |
| `TEAMS_BOT_PORT`                  | optional | `3978`          |                                                                   |
| `TEAMS_BOT_TENANT_ID`             | optional | —               |                                                                   |
| `TEAMS_CARD_MAX_BYTES`            | optional | `24000`         |                                                                   |
| `TEAMS_DEV_ALLOW_UNAUTHENTICATED` | optional | `false`         | Development only; refused in production.                          |
| `TEAMS_DEV_MOCK_IDENTITY`         | optional | `false`         | Development only; refused in production.                          |
| `TEAMS_DEV_MOCK_USER_ID`          | optional | `dev-mock-user` |                                                                   |
| `TEAMS_MAX_CONCURRENT_QUESTIONS`  | optional | `8`             |                                                                   |
| `TEAMS_SSO_CONNECTION_NAME`       | optional | —               |                                                                   |

### Teams manifest (build-time)

| Variable               | Required | Default | Notes                                                                   |
| ---------------------- | -------- | ------- | ----------------------------------------------------------------------- |
| `TEAMS_APP_ID`         | required | —       |                                                                         |
| `TEAMS_BOT_CLIENT_ID`  | required | —       |                                                                         |
| `TEAMS_DEVELOPER_NAME` | required | —       |                                                                         |
| `TEAMS_PRIVACY_URL`    | required | —       |                                                                         |
| `TEAMS_SSO_RESOURCE`   | optional | —       | Must match `ENTRA_API_APP_ID_URI` (optionally with the scope appended). |
| `TEAMS_TERMS_URL`      | required | —       |                                                                         |
| `TEAMS_WEBSITE_URL`    | required | —       |                                                                         |

### Administration area

| Variable               | Required | Default             | Notes                                                |
| ---------------------- | -------- | ------------------- | ---------------------------------------------------- |
| `ADMIN_PUBLIC_ORIGIN`  | optional | —                   |                                                      |
| `ADMIN_RETENTION_DAYS` | optional | `90`                |                                                      |
| `ADMIN_SPA_CLIENT_ID`  | optional | —                   |                                                      |
| `ADMIN_STATE_DIR`      | optional | `.ehub/admin-state` |                                                      |
| `ADMIN_UI_ENABLED`     | optional | `false`             | Off by default; needs `ADMIN_SPA_CLIENT_ID` when on. |

### Azure identity

| Variable              | Required | Default | Notes      |
| --------------------- | -------- | ------- | ---------- |
| `AZURE_CLIENT_ID`     | required | —       |            |
| `AZURE_CLIENT_SECRET` | optional | —       | **secret** |
| `AZURE_TENANT_ID`     | required | —       |            |

### Observability

| Variable                                | Required | Default | Notes                                                        |
| --------------------------------------- | -------- | ------- | ------------------------------------------------------------ |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | optional | —       | **secret** Key Vault secret `appinsights-connection-string`. |

<!-- /generated -->
