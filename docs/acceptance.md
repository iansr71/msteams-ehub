# Acceptance and evaluation

This describes how the assistant is tested end to end, how an answer is scored, and — just as
important — what passing does _not_ prove.

Two things are separate here:

- **Acceptance suites** (`tests/acceptance/`) ask "does the system behave correctly?" They run
  the real pipeline and the real answer engine against fakes, so they run anywhere, in CI and on
  a laptop, with no Azure or Moodle.
- **Evaluation runs** (`pnpm evaluation:*`) ask "are the answers right for our content?" They
  score question/answer cases against a _deployed_ environment: the real index, the real
  embedding model and the real language model.

| Command                     | What it does                                           | Needs   |
| --------------------------- | ------------------------------------------------------ | ------- |
| `pnpm test:acceptance`      | Runs the acceptance suites and writes the suite report | nothing |
| `pnpm test:security`        | Runs the security tests and writes the control report  | nothing |
| `pnpm evaluation:retrieval` | Scores `tests/evaluation/retrieval-cases.json`         | Azure   |
| `pnpm evaluation:answers`   | Scores `tests/evaluation/answer-cases.json`            | Azure   |
| `pnpm evaluation:full`      | Both of the above, retrieval first                     | Azure   |

`pnpm test:acceptance` writes `reports/acceptance/acceptance-report.json` and
`acceptance-report.md`; add `-- --write-docs` to refresh the committed copy at
`docs/acceptance-report.md`.

## The suites

`tests/acceptance/suites.json` is the catalogue: every suite's ID, name, the files that make it
up, what passing it proves, and which live service it needs. `scripts/acceptance-report.mjs`
runs the catalogue and reports pass or fail per suite. A suite passes only when every listed file
produced results and every test in it passed; a _skipped_ test makes the suite `incomplete`,
which the report counts as a failure, because a suite that quietly stops running is exactly the
failure this report exists to catch. A test added to `tests/acceptance/` but not listed in the
catalogue fails the catalogue test, so a new suite cannot go unreported.

Suites 01 to 19 run anywhere. Suites E1 to E4 can only be checked against a deployment; they are
listed in the report with the command to run, and never affect its exit code.

## The end-to-end stack

`tests/acceptance/framework/endToEnd.ts` builds one stack in which the indexer writes to a fake
Azure AI Search service and the answer engine reads from that same index with the same embedding
model. Only Moodle, Search, the embedding service and the chat model are fakes. Everything in
between — discovery, download, extraction, chunking, change detection, cleanup, retrieval,
prompt building, grounding, citation validation, authorization — is the production code.

The chat model is a _quoting_ model: it answers by quoting the passages the prompt put in front
of it. That is deliberate. It makes an answer a faithful window onto the index, so a content
change shows up as an answer change, and a passage that was removed cannot be quoted. It also
means the grounding and citation checks run against real model output shapes rather than
hand-written answers.

## Evaluation datasets

All five kinds live in `tests/evaluation/` and are validated by Zod schemas before use, so a
mistyped case fails loudly instead of testing nothing.

| File                        | Schema                                      | Drives                 |
| --------------------------- | ------------------------------------------- | ---------------------- |
| `retrieval-cases.json`      | `apps/api/src/retrieval/evaluationCases.ts` | `evaluation:retrieval` |
| `answer-cases.json`         | same schema                                 | `evaluation:answers`   |
| `security-cases.json`       | `tests/acceptance/framework/datasets.ts`    | suite 14               |
| `authorization-cases.json`  | same                                        | suite 13               |
| `content-update-cases.json` | same                                        | suite 19               |

Suites 08 and 09 use their own fixture documents rather than these datasets: a dataset case
names real E-Hub resource IDs, which exist only in a deployment. The datasets drive suites 13,
14 and 19 and the two evaluation commands.

An answer case carries the question, the authorized course IDs, the expected resource IDs, the
required and forbidden facts, and whether the expected outcome is insufficient evidence or a
reported conflict. The content-update schema refuses a case whose "before" fact also appears
after the change, or whose "after" fact already appeared before — such a case could never prove
the change took effect.

The cases shipped here are templates with placeholder content. Replace them with real staff
questions and real E-Hub wording during the pilot; that is what turns the framework into a
measurement.

## How an answer is scored

Scoring is deterministic. No model grades another model's answer.

A fact is matched by normalizing both sides (NFC, lower case, collapsed whitespace) and testing
for containment, over the answer plus every claim. A matcher can be a phrase or
`{ "anyOf": [...] }` when more than one wording is acceptable.

Failures carry a severity, and the worst one decides the case:

| Severity      | Failures                                                                                                                                                                     | Meaning                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `critical`    | `secret_in_output`, `unauthorized_citation`, `forbidden_resource_cited`                                                                                                      | A security boundary was crossed. Stop and fix before anything else.                                    |
| `grounding`   | `no_valid_source`, `citation_not_in_sources`, `forbidden_fact_present`                                                                                                       | The answer was not supported by what was retrieved.                                                    |
| `error`       | `failed_answer`, `error`                                                                                                                                                     | The case could not be judged.                                                                          |
| `expectation` | `expected_resource_not_cited`, `missing_required_fact`, `expected_insufficient_evidence`, `unexpected_insufficient_evidence`, `conflict_not_reported`, `unexpected_conflict` | The system worked, but not as the case expected. Often the case or the content is what needs changing. |

The rules Prompt 18 sets out, as implemented:

- A substantive answer with no valid citation fails (`no_valid_source`).
- A citation that does not map to a retrieved chunk fails (`citation_not_in_sources`).
- Any citation outside the user's authorized courses is a critical failure.
- Any configured secret appearing in the output is a critical failure.
- An unsupported claim is a grounding failure.
- An unanswerable question passes only when the system returns the fixed insufficient-evidence
  response.

A qualitative evaluator may be added later, but its score is reported separately and never
decides pass or fail.

## What grounding does and does not prove

This is the most important limitation in the whole framework, and suite 09 records it as a test
rather than leaving it in a document nobody reads.

`ClaimSupportValidator` is mechanical. It catches a claim with no valid citation, an invented
page or slide number, an invented document or link, a number that appears in no source, and a
claim with no wording overlap with the passage it cites. It does **not** judge meaning. A claim
that cites a real passage and reuses its words can still contradict that passage and pass.

So: these tests prove the answer is traceable to indexed E-Hub content, and that content the
user may not read never reaches them. They do not prove the answer is a correct reading of that
content, and they cannot prove the content in Moodle is correct or current. Spot-checking
answers against the source is a pilot activity, not something a test suite can replace.

Two related limits worth stating:

- The chat model in the suites is a fake. Nothing here predicts how a real model phrases an
  answer, how often it hedges, or how it behaves on a question none of the cases cover.
- The suites use small fixture documents. Retrieval ranking on a real index of the whole E-Hub
  is what `pnpm evaluation:retrieval` measures, against a deployment.

## Checks that need a deployment

| ID  | Check                                                                                                                                     | How                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| E1  | The E-Hub server answers `core_webservice_get_site_info` with the deployed token                                                          | `pnpm diagnose`          |
| E2  | The deployed search index, embedding deployment and chat deployment answer with the deployed identity, and the state stores are reachable | `pnpm diagnose`          |
| E3  | Retrieval and answer cases score against the real index and model                                                                         | `pnpm evaluation:full`   |
| E4  | A staff member can install the personal app, sign in with Entra SSO, get an answer, and follow its citation links into Moodle             | manual, during the pilot |

For E4, work through at least: install from the uploaded Teams app package; sign in; ask a
question whose answer is in a course the tester is enrolled in; ask one in a course they are not
enrolled in and confirm the refusal; follow every citation link and confirm it opens the right
Moodle activity; ask something E-Hub does not cover and confirm the insufficient-evidence reply.

## Adding a suite

1. Write `tests/acceptance/NN-name.test.ts`, building the stack with `createEndToEndStack()`.
2. Add it to `tests/acceptance/suites.json` with what it proves and `requires`.
3. Run `pnpm test:acceptance`.
