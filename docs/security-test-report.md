# Security test report

Generated 2026-11-11 from commit `a2e8eda93e21`, Node.js v22.23.4.

**Result: PASS.** 21 of 21 controls passed; 905 tests passed, 0 failed, 0 skipped. Secret scan: pass (463 files).

Regenerate with `pnpm test:security` (add `-- --write-docs` to update this file).

## What this report is, and is not

- It lists the security controls in this repository and whether the automated tests for each one passed on the commit above.
- The tests run without Azure, Moodle, Teams or a real language model. They show what the application does with hostile input and hostile model output; they do not show how the deployed model, tenant or network behave.
- It is not a penetration test, an audit, or a statement of compliance with any standard or regulation (including POPIA, ISO 27001 and SOC 2).
- Known gaps and risks that tests cannot cover are in docs/threat-model.md.

## Attack tests

| Attack                           | Control | Result |
| -------------------------------- | ------- | ------ |
| user prompt injection            | PI-1    | pass   |
| PDF prompt injection             | PI-2    | pass   |
| hidden HTML instructions         | PI-3    | pass   |
| oversized question               | IN-1    | pass   |
| script output                    | OUT-1   | pass   |
| malicious citation               | OUT-2   | pass   |
| token leakage through exceptions | SRV-4   | pass   |
| SSRF URL                         | SSRF-1  | pass   |
| unauthorized resource URL        | SSRF-2  | pass   |
| forged identity fields           | AUTH-1  | pass   |
| forged course ID                 | AUTH-2  | pass   |
| admin-role bypass                | AUTH-3  | pass   |

## Controls

### Prompt injection

| ID   | Control                                                                                                                                                                                      | Result | Tests     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| PI-1 | System instructions, the user's question and retrieved passages are kept apart; look-alike tags in user or document text are defused                                                         | pass   | 7 passed  |
| PI-2 | Retrieved passages are labelled untrusted evidence; output that follows a document's instructions (unsupported claims, foreign links, invented sources) is removed or the answer is withheld | pass   | 2 passed  |
| PI-3 | Text a reader cannot see (hidden elements, comments, scripts, attributes) is not indexed; nothing a page refers to is fetched                                                                | pass   | 60 passed |

### Input controls

| ID   | Control                                                                                                                             | Result | Tests     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| IN-1 | Question length limit, request-size limit (declared and streamed), content-type and schema validation; parser errors are not echoed | pass   | 22 passed |
| IN-2 | Unicode normalisation; control and direction-override characters removed from questions, sources and card text                      | pass   | 27 passed |
| IN-3 | Per-user rate limits (questions and feedback) and a concurrency cap, keyed by the validated identity                                | pass   | 22 passed |

### Output controls

| ID    | Control                                                                                                                                             | Result | Tests     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| OUT-1 | Model output is never rendered as HTML or Markdown: JSON responses with no-sniff headers, plain-text runs in Adaptive Cards, card templates defused | pass   | 26 passed |
| OUT-2 | Citations come from retrieved chunks only; unknown or invented sources are dropped; links are https on allowlisted Moodle hosts                     | pass   | 31 passed |

### Server controls

| ID    | Control                                                                                                                                                      | Result | Tests      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------- |
| SRV-1 | Secure response headers on the API, the bot and the administration page; no cross-origin access (no CORS headers, preflight refused)                         | pass   | 6 passed   |
| SRV-2 | Browser mutations on the administration page need a bearer token (no cookies), a same-origin Origin header and explicit confirmation for destructive actions | pass   | 34 passed  |
| SRV-3 | Request timeout and dependency timeouts (Moodle, readiness probes); HTTPS required for every service URL in production                                       | pass   | 125 passed |
| SRV-4 | Error responses carry a code, a fixed message and a reference only: no exception text, stack, URL or credential; failures are logged with secrets redacted   | pass   | 62 passed  |

### SSRF defences

| ID     | Control                                                                                                                                                                                                          | Result | Tests      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| SSRF-1 | Only Moodle file URLs on the configured site are downloaded; redirects only to approved hosts; loopback, link-local and metadata addresses refused; the token never leaves the Moodle host; no API accepts a URL | pass   | 105 passed |
| SSRF-2 | Download paths are limited to Moodle's file endpoints; traversal, other endpoints and injected credentials are refused                                                                                           | pass   | 11 passed  |

### File processing

| ID     | Control                                                                                                                                                      | Result | Tests     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------- |
| FILE-1 | Content type decided from the bytes, not the declared type; input-size limit; parser timeout; unsupported and encrypted files reported, not parsed           | pass   | 47 passed |
| FILE-2 | Archives (docx, pptx): entry-count, per-entry and total decompression limits, compression-ratio check, traversal-safe entry names, encrypted entries refused | pass   | 38 passed |

### Authentication and authorisation

| ID     | Control                                                                                                                                                                          | Result | Tests      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| AUTH-1 | Entra tokens: signature, issuer, audience, tenant, expiry, version, scope and calling app are validated; identity comes only from the validated token; unknown users are refused | pass   | 28 passed  |
| AUTH-2 | Course filtering happens before retrieval, from Moodle enrolments; a course the user is not enrolled in is refused; it fails closed when Moodle cannot confirm                   | pass   | 51 passed  |
| AUTH-3 | Administration actions are checked server-side against app roles in the token, for every endpoint and role                                                                       | pass   | 120 passed |

### Secrets

| ID    | Control                                                                                                                                                                                                                                    | Result | Tests     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------- |
| SEC-1 | Configuration is validated at start-up and reported by variable name only; every secret setting is registered for redaction; nothing sensitive reaches logs or telemetry; source files carry no invisible or direction-override characters | pass   | 76 passed |
| SEC-2 | Deployed services read secrets from Key Vault with managed identities; Azure AI Search keys are disabled; nothing tenant-specific or secret is committed; committed files are scanned for secrets                                          | pass   | 58 passed |

## Test files

- `apps/api/src/admin/admin.test.ts`
- `apps/api/src/admin/adminRoles.test.ts`
- `apps/api/src/auth/entraTokenValidator.test.ts`
- `apps/api/src/authorization/authorization.test.ts`
- `apps/api/src/health/readiness.test.ts`
- `apps/api/src/http/apiServer.test.ts`
- `apps/api/src/http/requestLimits.test.ts`
- `apps/api/src/rag/citations.test.ts`
- `apps/api/src/rag/rag.test.ts`
- `apps/indexer/src/extractors/contentTypeDetector.test.ts`
- `apps/indexer/src/extractors/docxExtractor.test.ts`
- `apps/indexer/src/extractors/extractorRegistry.test.ts`
- `apps/indexer/src/extractors/htmlExtractor.test.ts`
- `apps/indexer/src/extractors/pdfExtractor.test.ts`
- `apps/indexer/src/extractors/pptxExtractor.test.ts`
- `apps/indexer/src/extractors/safeZip.test.ts`
- `apps/indexer/src/extractors/textNormalization.test.ts`
- `apps/teams-app/src/cards/cards.test.ts`
- `apps/teams-app/src/teams/httpAdapter.test.ts`
- `packages/moodle-client/src/downloader.test.ts`
- `packages/moodle-client/src/transport.test.ts`
- `packages/shared/src/config/config.test.ts`
- `packages/shared/src/http/networkHosts.test.ts`
- `packages/shared/src/logging/logger.test.ts`
- `packages/shared/src/logging/redaction.test.ts`
- `tests/integration/infrastructure.test.ts`
- `tests/security/attacks/admin-role-bypass.test.ts`
- `tests/security/attacks/malicious-output.test.ts`
- `tests/security/attacks/prompt-injection.test.ts`
- `tests/security/attacks/request-forgery.test.ts`
- `tests/security/attacks/ssrf-and-resource-urls.test.ts`
- `tests/security/attacks/token-leakage.test.ts`
- `tests/security/course-authorization.test.ts`
- `tests/security/env-example.test.ts`
- `tests/security/pdf-parser.test.ts`
- `tests/security/secret-scan.test.ts`
- `tests/security/source-characters.test.ts`
- `tests/security/telemetry-redaction.test.ts`
