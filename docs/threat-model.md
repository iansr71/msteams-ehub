# Threat model

This covers the E-Hub Teams Knowledge Assistant as deployed by `infrastructure/` (docs/infrastructure.md). For each trust boundary it lists what crosses it, what could go wrong, the controls that address it, and what is left. Control IDs (PI-1, AUTH-2 and so on) refer to `tests/security/controls.json` and docs/security-test-report.md. A control's ID means automated tests check it.

## What is being protected

- **Course content.** Staff should see answers only from the Moodle courses they are enrolled in. Content is internal training material; some of it is clinical procedure.
- **Answer integrity.** An answer must come from the retrieved course content. It must not come from instructions planted in a document or a question, and it must not invent sources or links.
- **Credentials.** The Moodle web-service token (it reads every included course), the bot client secret, the Application Insights connection string and the managed identities' access.
- **Personal information.** Staff names, email addresses and Entra object IDs (POPIA personal information). Questions can also mention clients.
- **Availability** for about 120 staff, 90 of them branch staff signing in as Teams guests.

## Data flow

```text
Staff (Teams desktop, web, mobile; members and guests)
  │ ① Teams client → Bot Framework → bot (HTTPS, Bot Framework JWT)
  ▼
Bot (Container App) ── ② Entra token (SSO, on-behalf-of) ──▶ Answer API (Container App, public HTTPS) ③
                                                                │
        ┌───────────────────────┬───────────────────────────────┼───────────────────────┬───────────────┐
        ▼                       ▼                               ▼                       ▼               ▼
  ④ Moodle REST API     ⑥ Azure AI Search              ⑦ Azure OpenAI (model)   ⑨ State share    ⑩ Logs, traces
  (enrolments, users)   (index, Entra RBAC)            (chat, embeddings)        (Azure Files)    (Log Analytics,
        ▲                       ▲                                                                   App Insights)
  ⑤ Moodle documents ──▶ Indexer jobs (download, extract, chunk, embed, index)
Administrators ── ⑧ admin page (/admin on the API, MSAL sign-in, app roles)
```

## Trust boundaries

### ① Teams client → bot

- **Crosses:** Teams activities, including the user's message, from Microsoft's Bot Framework service.
- **Threats:**
  - forged activities sent straight to the bot's public endpoint;
  - spoofed user fields (`from.id`, `aadObjectId`, display names);
  - floods;
  - oversized bodies.
- **Controls:**
  - The Teams SDK validates the Bot Framework token on every request. The development bypass works only with `NODE_ENV=development`, and every Azure environment sets `production` (AUTH-1, SEC-2).
  - The bot never takes identity from activity fields. It forwards the user's Entra token unread (AUTH-1).
  - The body size is limited, and refused requests are counted (`ehub.access.denials`).
  - Responses carry secure headers (SRV-1).
- **Residual:** the bot's endpoint is public by design (Bot Framework must reach it). Rate limiting happens at the API, per validated user, not at the bot.

### ② Entra token

- **Crosses:** an access token for `api://<API_ID>/access_as_user`, obtained by on-behalf-of exchange on the Azure Bot's OAuth connection.
- **Threats:**
  - forged or tampered tokens, `alg: none`, tokens for another audience or tenant;
  - expired or app-only tokens;
  - token theft from logs;
  - stolen user sessions.
- **Controls:**
  - The API checks the RS256 signature against Entra's keys. It also checks issuer, audience, tenant, expiry, not-before, version 2.0, the `access_as_user` scope and the calling app (`azp` must be the bot or the admin page), and requires a user token (AUTH-1).
  - Identity comes only from the validated token's `oid`.
  - Tokens are never logged or put in telemetry (SEC-1, SRV-4, docs/observability.md).
  - If Entra's keys cannot be fetched, the API refuses (fail closed).
- **Residual:**
  - **No Conditional Access.** Skin Renewal has no Entra ID P1, so there is no Conditional Access, no sign-in risk policy and only 7 days of sign-in logs. A stolen staff session works until the token expires. This is a tenant-level gap, not one the application can close.
  - **Guest SSO unverified.** Guests on personal Microsoft accounts or one-time passcodes may not be able to complete Teams SSO for a custom app (docs/entra-sso.md). That is a usability risk, not an access risk: the failure is closed.

### ③ Public answer API

- **Crosses:** HTTPS requests from the bot and from the admin page in browsers. The endpoint is reachable from the internet (Container Apps external ingress).
- **Threats:**
  - unauthenticated access;
  - injection through the question;
  - oversized or malformed bodies;
  - floods and cost abuse (each question costs model tokens);
  - cross-origin use from a browser;
  - verbose errors leaking internals.
- **Controls:**
  - Every route except health requires a valid Entra token (AUTH-1).
  - Question limits: length cap, Unicode NFC normalisation, and control and direction-override characters removed (IN-1, IN-2).
  - Request body limits: a 16 KB declared and streamed limit, JSON content-type only, strict schema validation, and parser errors never echoed (IN-1).
  - Per-user rate limits on questions and feedback, keyed by tenant and validated object ID, plus a cap on concurrent answers (IN-3).
  - A request timeout and dependency timeouts (SRV-3).
  - Secure headers on every response, and no CORS headers (SRV-1).
  - Errors are a code, a fixed message and a reference ID (SRV-4).
  - HTTPS only: ingress refuses plain HTTP, and HSTS is set.
- **Residual:**
  - **Limits are per replica.** Rate limits live in memory in the single replica. A restart resets them, and scaling out would need a shared store.
  - **No network-level protection.** There is no web application firewall or Front Door; Container Apps ingress is the edge.
  - **Ingress is public.** The admin page needs it, so restricting by IP would also block branch staff, whose browsers reach the admin page from the internet. With the admin page disabled, the API could move to internal ingress (a phase 20 decision).

### ④ Moodle REST API

- **Crosses:** web-service calls with the service account's token: course contents, enrolments, user lookups.
- **Threats:**
  - token theft (it reads every included course);
  - the token leaking through URLs, errors or logs;
  - a compromised or spoofed Moodle answering with crafted data;
  - the API being steered to call Moodle functions it does not need.
- **Controls:**
  - The token is in Key Vault and read through a managed identity (SEC-2). It is registered for redaction, never logged, and never in telemetry, where HTTP auto-instrumentation is off because URLs carry it (SEC-1, docs/observability.md).
  - Function names come from a fixed, typed list in the code (`SUPPORTED_MOODLE_FUNCTIONS`, docs/moodle-setup.md), so no request can supply one. Parameters cannot override `wsfunction` or the token.
  - Every response is validated with Zod.
  - HTTPS is required in production, and the URL must not be a loopback, link-local or metadata address (SRV-3).
  - Enrolment failures fail closed: no courses (AUTH-2).
- **Residual:**
  - **The token sees too much.** Its reach is everything the service account can see. Least privilege is a Moodle configuration task: a dedicated role with only the listed functions, an IP restriction if the virtual network option is used, and an expiry (phase 20 checklist).
  - **Lookups depend on the token's scope.** Identity mapping by email depends on what the service account may look up.

### ⑤ Moodle documents (indexed content)

- **Crosses:** PDFs, Office files, HTML pages and Book chapters written by course authors, downloaded by the indexer.
- **Threats:**
  - instructions aimed at the model, visible or hidden (prompt injection);
  - malicious files: parser bombs, zip bombs, path traversal, encrypted or malformed files;
  - documents that point the indexer at other URLs (SSRF);
  - script and markup carried through to answers.
- **Controls:**
  - Downloads only from Moodle's file endpoints on the configured host. Redirects only to approved hosts, and never to loopback, link-local or metadata addresses. The token is never forwarded on a redirect (SSRF-1, SSRF-2).
  - The content type is decided from the bytes. There are size limits, a parser timeout, and archive entry-count, per-entry and total decompression limits with a ratio check. Archive entry names are traversal-safe, and encrypted or unsupported files are reported, not indexed (FILE-1, FILE-2).
  - Text a reader cannot see is not indexed: hidden elements, comments, scripts, attributes, zero-size or off-screen text. Nothing a page refers to is fetched (PI-3).
  - Retrieved passages are marked as untrusted evidence, both in the system prompt and next to the passages. The model has no tools (PI-1, PI-2).
  - Every claim must cite a retrieved passage. Unsupported claims are removed, and an answer with none left is withheld (PI-2, OUT-2).
- **Residual:**
  - **Some hidden text is not detected:** text hidden by colour (white on white), or by a stylesheet rule rather than an inline style.
  - **A misleading document still gets cited.** A course author who writes false content gets it cited faithfully. Document integrity is a Moodle permissions question (who may edit courses), not something retrieval can judge.
  - **Injected instructions can only change wording.** Grounding and citation checks limit what such text can achieve to rewording claims that the passages support. They cannot make the model ignore it entirely.

### ⑥ Azure AI Search

- **Crosses:** chunk text, embeddings and metadata (indexer writes); filtered queries (API reads).
- **Threats:**
  - a stolen admin key;
  - a query without a course filter returning other courses' content;
  - filter injection through course IDs.
- **Controls:**
  - API keys are disabled; access is by Entra RBAC per identity. The API can only read when the admin page is off (SEC-2, docs/infrastructure.md).
  - The course filter is built from authorised integer course IDs before every query, never from user text, and a forged course ID is refused (AUTH-2).
- **Residual:**
  - **Search is publicly addressable.** It is protected by RBAC; a private endpoint would need the virtual network option.
  - **The admin page widens the API's search access.** With it enabled, the API identity gets search write roles (docs/infrastructure.md).

### ⑦ Model endpoint (Azure OpenAI)

- **Crosses:**
  - **Prompts:** system instructions, the question and retrieved passages.
  - **Completions:** the model's reply.
  - **Embedding requests:** chunk and question text.
- **Threats:**
  - model output carrying script, markup, links or invented citations;
  - output that leaks the system prompt;
  - the model being steered into revealing other users' data, which it never holds;
  - key theft.
- **Controls:**
  - The model's reply must be a JSON object that passes schema validation.
  - Output is never rendered as HTML or Markdown: Adaptive Card text is plain, and card templates are defused (OUT-1).
  - Citations map only to retrieved chunks, and links must be https on allowlisted Moodle hosts (OUT-2).
  - The system prompt forbids revealing credentials or its rules (PI-1).
  - Managed identity is used; there is no key in Azure (SEC-2).
- **Residual:**
  - **Text from prompts and passages goes to Microsoft.** Azure OpenAI processes it under Microsoft's data terms; check the region and data-processing settings for POPIA.
  - **The system prompt is not secret.** If revealed it exposes nothing sensitive, by design.

### ⑧ Administration page

- **Crosses:** browser requests with an MSAL token, and administrative mutations: sync, re-index, identity overrides, cache refresh.
- **Threats:**
  - **CSRF and XSS.** Cross-site request forgery; cross-site scripting stealing the session token.
  - **Role bypass.** Using the page without an administration role.
  - **Clickjacking.**
  - **Hand-crafted requests** that read new courses or change identities.
- **Controls:**
  - Bearer tokens only, no cookies. The Origin header must match on every mutation, and destructive actions need `"confirm": true` (SRV-2).
  - A strict CSP with no inline script, MSAL served locally from the repository's own pinned copy, and framing denied (SRV-1).
  - Every endpoint is checked server-side against the token's app roles (AUTH-3).
  - Actions accept only courses already in the sync selection and resources in the state store.
  - Every mutation is audited.
- **Residual:**
  - **Token storage.** MSAL keeps the token in `sessionStorage`: one tab, cleared on close. Script running in the page could read it, so the CSP is what protects it.
  - **Role assignment is per user.** Without P1, groups cannot be used.

### ⑨ State database (Azure Files share)

- **Crosses:** sync state, identity mappings and overrides, admin audit and usage records, the embedding cache.
- **Threats:**
  - tampering, for example a forged identity mapping that grants someone else's courses;
  - loss;
  - the storage account key leaking;
  - concurrent writers corrupting files.
- **Controls:**
  - Only the API and job identities mount the share.
  - Files are versioned JSON with lock files and replace-by-rename.
  - Identity overrides need an Application Administrator and Moodle confirmation, and are audited (AUTH-3).
  - Soft delete and, in production, a deletion lock.
- **Residual (significant; see docs/infrastructure.md):**
  - **The account key is in use.** Container Apps mounts the share with it, so anyone with that key can change identity mappings.
  - **Locking over SMB is unverified.**
  - **One API replica only.**
  - **No backup is configured.**
  - **Before production with all staff:** replace the share with a database store (Azure SQL or PostgreSQL with managed identity) and add a backup.

### ⑩ Application logs and telemetry

- **Crosses:** JSON logs to stdout (Log Analytics), traces and metrics (Application Insights).
- **Threats:** credentials, tokens, questions, answers, document text or personal information reaching logs that many people can read.
- **Controls:**
  - Structured logs. Every secret setting is registered for redaction at start-up, and free-text patterns are redacted: Bearer, JWT, URL tokens and named credentials (SEC-1).
  - Questions, answers and document text are never logged; only lengths and counts are.
  - Telemetry uses allow-listed names and dimensions, no exception messages, and no automatic HTTP spans. The process resource detector is blocked. An end-to-end redaction test covers this (docs/observability.md).
  - Errors to clients carry a reference, not details (SRV-4).
- **Residual:**
  - **Pseudonymous IDs are still personal data.** Entra object IDs and Moodle user IDs appear in logs and the audit trail. That is pseudonymous personal information under POPIA, so set Log Analytics retention and access accordingly.
  - **Redaction catches known patterns only.** A credential with no recognisable shape that some library prints could pass.

## Cross-cutting

- **Supply chain.** Dependencies are pinned by `pnpm-lock.yaml`, and MSAL Browser is version-checked at start-up. **There is no automated dependency scanning or update process** (no Dependabot or CI yet). Run `pnpm audit` before each release and set up automated updates in phase 20.
- **Secrets in the repository.**
  - `pnpm secrets:scan` checks every tracked and untracked file and runs inside `pnpm test:security`.
  - `.gitleaks.toml` configures gitleaks for anyone who uses it.
  - Neither looks at git history.
- **Base image.** `node:22-bookworm-slim` is not pinned by digest unless `EHUB_NODE_IMAGE` sets one.
- **Domain names that resolve to local addresses.** SSRF checks catch loopback, link-local and metadata addresses written as IPs or known names. A domain name that **resolves** to such an address (DNS rebinding) is not caught. The downloader also accepts only the configured Moodle host and listed redirect hosts, which limits this to a compromised Moodle or DNS.

## Residual risk register

| Risk                                                            | Likelihood        | Impact                                 | Action                                                                  | When                            |
| --------------------------------------------------------------- | ----------------- | -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| File state store: shared key, SMB locking unverified, no backup | Medium            | High (identity mappings decide access) | Database store with managed identity, plus backup                       | Before production for all staff |
| No Conditional Access (no Entra P1)                             | Medium            | High                                   | Tenant decision: P1 for at least admins, or accept and monitor sign-ins | Before production               |
| Moodle service account broader than needed                      | Medium            | High                                   | Dedicated role, listed functions only, token expiry, IP restriction     | Phase 20 checklist              |
| No automated dependency scanning                                | Medium            | Medium                                 | Dependabot or Renovate, plus `pnpm audit` in release checks             | Phase 20                        |
| Guests unable to use Teams SSO                                  | Unknown           | Medium (adoption)                      | Test with one real guest during the pilot                               | Pilot                           |
| Rate limits per replica, in memory                              | Low (one replica) | Low                                    | Shared store if the API scales out                                      | With the database store         |
| Hidden text by colour or stylesheet; DNS rebinding              | Low               | Medium                                 | Accepted; course authors are internal                                   | Review if content sources widen |
| Public API ingress                                              | Low               | Medium                                 | Internal ingress if the admin page is not needed                        | Phase 20 decision               |
