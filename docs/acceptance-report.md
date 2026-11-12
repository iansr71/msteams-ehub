# Acceptance test report

Generated 2026-11-12 from commit `61816c07544e` with uncommitted changes, Node.js v22.23.4.

**Result: PASS.** 19 of 19 runnable suites passed; 97 tests passed, 0 failed, 0 skipped. 4 suites need a live service and were not run.

Regenerate with `pnpm test:acceptance` (add `-- --write-docs` to update this file).

## What this report is, and is not

- It lists the acceptance suites in this repository and whether their automated tests passed on the commit above.
- The runnable suites use fakes for Moodle, Azure AI Search, the embedding service and the chat model. The indexing pipeline, retrieval, grounding, citation, authorization and Teams rendering code is the real code, so an answer depends on what the pipeline actually indexed.
- Because the chat model is a fake that quotes the retrieved passages, these suites prove the system is faithful to the index. They do not predict how a real language model phrases answers, nor how good the content in Moodle is.
- Checks that need a live Moodle, Azure or Teams are listed below and must be run against a deployment.

## Suites

| ID | Suite | Result | Tests |
| --- | --- | --- | --- |
| 01 | Moodle connectivity | pass | 6 passed |
| 02 | Course discovery | pass | 4 passed |
| 03 | File downloading | pass | 3 passed |
| 04 | Content extraction | pass | 4 passed |
| 05 | Chunking | pass | 3 passed |
| 06 | Embedding | pass | 3 passed |
| 07 | Indexing | pass | 3 passed |
| 08 | Retrieval quality | pass | 5 passed |
| 09 | Grounded answer quality | pass | 10 passed |
| 10 | Citation accuracy | pass | 5 passed |
| 11 | Teams rendering | pass | 6 passed |
| 12 | Entra authentication | pass | 9 passed |
| 13 | Moodle course authorization | pass | 7 passed |
| 14 | Prompt injection | pass | 6 passed |
| 15 | Deleted-content cleanup | pass | 5 passed |
| 16 | Incremental synchronization | pass | 5 passed |
| 17 | Failure recovery | pass | 6 passed |
| 18 | Monitoring and redaction | pass | 6 passed |
| 19 | Content update, end to end | pass | 1 passed |

## Checks that need a live service

| ID | Check | Needs | How to run |
| --- | --- | --- | --- |
| E1 | Live Moodle reachability | moodle | `pnpm diagnose` |
| E2 | Live Azure Search and model | azure | `pnpm diagnose` |
| E3 | Live retrieval and answer evaluation | azure | `pnpm evaluation:full` |
| E4 | Teams and Entra sign-in | teams | `manual: see docs/acceptance.md, "Checks that need a deployment"` |

## What each suite proves

- **01 Moodle connectivity** — The client reaches a Moodle web-service endpoint, keeps the token out of URLs, classifies rejected tokens and throttling, and refuses undocumented response shapes.
- **02 Course discovery** — Only selected, visible courses and activities are discovered, and hidden or unavailable material is excluded.
- **03 File downloading** — Activity files are fetched from the token-authenticated pluginfile endpoint within the size limit.
- **04 Content extraction** — Supported formats yield text with page or slide numbers; unsupported and unreadable files are quarantined rather than indexed empty.
- **05 Chunking** — Chunks respect the target size, carry heading paths and page or slide metadata, and are numbered within the resource.
- **06 Embedding** — Chunks are embedded in batches at the configured dimensions, cached by content hash, and re-embedded when the model or version changes.
- **07 Indexing** — Chunks reach the index with their Moodle metadata, and a resource's surplus chunks are removed when it shrinks.
- **08 Retrieval quality** — Indexed content is retrievable for the question that it answers, and retrieval never crosses a course boundary. Ranking against real E-Hub content is measured by `pnpm evaluation:retrieval` against a deployment.
- **09 Grounded answer quality** — Claims without support are removed, invented numbers, pages, documents and links are rejected, and an unanswerable question gets the fixed insufficient-evidence reply. See docs/acceptance.md for what grounding does not prove.
- **10 Citation accuracy** — Every citation maps to a retrieved chunk and carries the real course, section, resource, page or slide and URL.
- **11 Teams rendering** — Answer, welcome and error cards are valid Adaptive Cards, and hostile text cannot become a link, action or template expression.
- **12 Entra authentication** — Only tokens with the expected issuer, audience, signature, lifetime and tenant are accepted, and failure is closed.
- **13 Moodle course authorization** — Retrieval is limited to the signed-in user's Moodle enrolments for every case in tests/evaluation/authorization-cases.json, and an unavailable Moodle fails closed.
- **14 Prompt injection** — The attacks in tests/evaluation/security-cases.json cannot change the assistant's instructions, widen access or leak credentials.
- **15 Deleted-content cleanup** — Deleted, hidden and deselected content stops being answerable, while the deletion guard prevents an outage from emptying the index.
- **16 Incremental synchronization** — Unchanged content is skipped without embedding cost, changed and new content is picked up, and a pipeline version change forces a re-index.
- **17 Failure recovery** — Moodle, index and lease failures leave the last good answers in place and recover without operator surgery.
- **18 Monitoring and redaction** — Jobs and answers emit structured JSON with correlation IDs and counts, carrying no credentials, questions or document text, and sync lag is reported.
- **19 Content update, end to end** — Prompt 18's end-to-end check: index version 1, answer from it, replace the source, re-sync, prove version 1's chunks are gone, and answer from version 2.
- **E1 Live Moodle reachability** — The configured E-Hub server answers core_webservice_get_site_info with the deployed token, so the web service, the account and the token all work.
- **E2 Live Azure Search and model** — The deployed search index, embedding deployment and chat deployment all answer with the deployed identity, and the state stores are reachable.
- **E3 Live retrieval and answer evaluation** — Retrieval and answer cases score against the real index and model rather than fakes.
- **E4 Teams and Entra sign-in** — A staff member can install the personal app, sign in with Entra SSO and get an answer with working citation links.
