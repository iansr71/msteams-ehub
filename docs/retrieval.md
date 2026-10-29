# Retrieval and the retrieval evaluation harness

Phase 7 adds filtered retrieval and a way to measure it, before any answer generation. Code is
in `apps/api/src/retrieval/`:

| Component               | Job                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `SearchQueryBuilder`    | Validates a request (Zod) and turns it plus the settings into a search query        |
| `RetrievalService`      | Runs the search, applies score thresholds and the per-resource cap, keeps the top K |
| `RetrievalResultMapper` | Maps a search hit to a `RetrievedChunk` with its citation metadata                  |
| `RetrievalDiagnostics`  | Operator output: ranks, scores, metadata; excerpts only when asked                  |
| `EvaluationRunner`      | Runs evaluation cases and computes pass/fail, hit@1/3/5 and MRR                     |

The REST request body is built by `buildSearchRequest` in `packages/shared/src/search/query.ts`.

## How a question is retrieved

1. The request is validated: question 1-1000 characters (control and bidirectional-override
   characters removed), at least one authorised course, known resource types only.
2. The search request carries every restriction in its `filter`, so Azure applies it inside the
   query and nothing depends on filtering afterwards:

   ```text
   tenantId eq '<tenant>' and isActive eq true and (courseId eq 12 or courseId eq 15)
     [and search.in(resourceType, 'pdf,docx', ',')]
   ```

3. Mode: **keyword** (text, plus semantic ranking when enabled), **hybrid** (text and a query
   vector), or **vector** (vector only; no text leg). Vector queries are pre-filtered.
4. `RETRIEVAL_CANDIDATE_COUNT` results are requested (default 24), then:
   - results below `RETRIEVAL_MIN_SCORE` or `RETRIEVAL_MIN_RERANKER_SCORE` are dropped;
   - at most `RETRIEVAL_MAX_CHUNKS_PER_RESOURCE` chunks per resource are kept (default 3), so
     one long document cannot crowd out others;
   - the first `RETRIEVAL_TOP_K` remain (default 8) and are re-ranked 1…K.
5. The response is checked: a result from another tenant, an unrequested course or inactive
   content fails the whole retrieval.

### Authorisation

Retrieval is scoped by **authorised Moodle course IDs**, which is how phase 14 enforces access.
An empty list is refused before any request, and a selected course outside the authorised set
is refused (`course_not_authorized`), not silently dropped. Until phase 14 the development
commands take the authorised courses from `--course-id` or from each evaluation case.

### Settings

| Variable                            | Default | Notes                                                   |
| ----------------------------------- | ------- | ------------------------------------------------------- |
| `RETRIEVAL_TOP_K`                   | 8       | 1-50                                                    |
| `RETRIEVAL_MAX_CHUNKS_PER_RESOURCE` | 3       | 1-50                                                    |
| `RETRIEVAL_CANDIDATE_COUNT`         | 24      | 1-50, at least top K                                    |
| `RETRIEVAL_SEMANTIC_RANKING`        | true    | Also needs `AZURE_SEARCH_SEMANTIC_ENABLED=true`         |
| `RETRIEVAL_MIN_SCORE`               | off     | Minimum `@search.score`                                 |
| `RETRIEVAL_MIN_RERANKER_SCORE`      | off     | 0-4; only applies to results that have a reranker score |

Active-content filtering is **not** a setting. Prompt 7 asks for all settings to be
configurable and also says inactive content must never be retrieved; the second requirement
wins, so `isActive eq true` is always in the filter.

Score scales differ by mode, so set thresholds from evaluation runs, not guesses:

- keyword (BM25) scores are unbounded and depend on the corpus;
- hybrid scores come from reciprocal rank fusion and are small (typically below 0.05);
- the semantic reranker score runs from 0 to 4 and is the most comparable across questions.

If semantic ranking does not run for a query (for example, the service returns a partial
response), results have no reranker score and `RETRIEVAL_MIN_RERANKER_SCORE` does not filter
them. Phase 9 applies its own support threshold before answering.

## Commands

```bash
pnpm api retrieve --question "How often should SPF be reapplied after a peel?" --course-id 12
pnpm api retrieve --question "..." --course-id 12,15 --resource-type pdf --top-k 5 --json
pnpm api retrieve --question "..." --course-id 12 --excerpts      # short sanitised excerpts
pnpm api retrieve --question "..." --course-id 12 --mode hybrid --vector-file query.json

pnpm evaluation retrieval --file tests/evaluation/retrieval-cases.json
pnpm evaluation retrieval --file tests/evaluation/retrieval-cases.json --case case-001 --json
```

- Needs `AZURE_SEARCH_*` and `AZURE_TENANT_ID` (the tenant the indexer stamps on each chunk).
- Output shows rank, course, resource, activity, title, page or slide, source URL, search
  score and reranker score. **Chunk text is never printed** unless `--excerpts` is given; an
  excerpt is at most 160 characters, one line, with control characters removed and secrets
  redacted, and is labelled as untrusted source text.
- The question is never logged.
- Vector and hybrid modes need a query vector. Until embeddings exist (phase 8), only a JSON file
  of numbers (`--vector-file`) can supply one; evaluation runs in keyword mode.
- Exit codes: `retrieve` 0 on success; `evaluation retrieval` 0 only if every case passes, 1
  otherwise; 2 for usage errors. Relative file paths resolve against the directory you ran
  `pnpm` from.

## Evaluation file format

A JSON array; `tests/evaluation/retrieval-cases.json` is a template.

```json
[
  {
    "id": "case-001",
    "question": "How often should a client reapply sunscreen after a chemical peel?",
    "authorizedCourseIds": ["12"],
    "expectedCourseIds": ["12"],
    "expectedResourceIds": ["701:chapter:11"],
    "forbiddenResourceIds": [],
    "notes": "Optional, for the people maintaining the file."
  }
]
```

| Field                  | Required | Meaning                                                                  |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `id`                   | yes      | Unique, letters/digits/`.`/`_`/`-`, up to 64 characters                  |
| `question`             | yes      | As a staff member would ask it                                           |
| `authorizedCourseIds`  | yes      | The simulated user's courses; the search is restricted to these          |
| `expectedCourseIds`    | no       | At least one result must come from one of these (must be authorised)     |
| `expectedResourceIds`  | no       | At least one must be retrieved; makes the case count towards the metrics |
| `forbiddenResourceIds` | no       | None may be retrieved (use for leak checks and outdated documents)       |
| `courseIds`            | no       | Narrowing within the authorised courses, as a course picker would        |
| `resourceTypes`        | no       | Restrict to extractor types (`pdf`, `docx`, `pptx`, `html`, …)           |
| `notes`                | no       | Free text, not scored                                                    |

Course IDs may be strings or numbers. A resource ID matches a retrieved chunk when it equals the
chunk's resource ID (`701:chapter:11`, `702:file:/Aftercare.pdf`, `703:page`) or its Moodle
activity ID (`701`). Use the activity ID when any part of an activity is a correct answer.

A case **passes** when there was no error, no result came from an unauthorised course, no
forbidden resource was retrieved, an expected resource was retrieved (if any are listed), and a
result came from an expected course (if any are listed).

### Metrics

Computed over cases that list expected resources; a case that errors counts as a miss.

- **Hit@1 / Hit@3 / Hit@5:** share of cases whose first expected resource is at rank ≤ 1, 3, 5.
- **MRR (mean reciprocal rank):** average of 1/rank of the first expected resource (0 if none).

## Creating a real E-Hub evaluation set

The template's course and resource IDs are placeholders. To build a set that measures real
retrieval quality:

1. **Collect real questions.** Ask branch managers, trainers and Head Office for 40-60
   questions staff actually ask (helpdesk tickets, WhatsApp groups, training sessions). Keep
   their wording, including vague and misspelt ones. Do not include client names or other
   personal information in questions.
2. **Cover the content.** Spread questions across courses and resource types (PDF, Word,
   PowerPoint, Pages, Books) and include questions answered on a specific page or slide.
3. **Find the answers in Moodle.** For each question, a subject expert opens the E-Hub course
   and notes the activity that answers it. Get IDs with:

   ```bash
   pnpm indexer moodle:courses --search "<course name>"
   pnpm indexer moodle:inspect --course-id <id>        # lists resource IDs and activity IDs
   ```

   Use the activity ID (`701`) unless only one chapter or file is correct.

4. **Set the user's courses.** `authorizedCourseIds` should be the courses a typical staff
   member asking that question is enrolled in, not every course.
5. **Add negative cases.**
   - Leak checks: a question answered only in course B, asked by a user authorised for course
     A, with course B's activity in `forbiddenResourceIds`. Include at least one per
     restricted course.
   - Outdated content: when an old procedure document still exists, list it as forbidden.
   - Unanswerable questions (no expected resources) to see what retrieval returns.
6. **Review.** Have a second person check each expected answer. Wrong labels make metrics
   meaningless.
7. **Index, then run** `pnpm evaluation retrieval --file <your file>` after phase 11 has
   indexed the courses. Record Hit@1/3/5 and MRR as the baseline, and re-run after any change
   to chunking, embeddings, semantic configuration or settings. Use `--case <id>` and
   `--excerpts` to investigate failures.
8. **Keep it current.** When courses are rewritten, update expected IDs. Store the file in the
   repository (it holds questions and IDs only, no course content) and treat it as reviewed
   material: it may reveal what staff ask about.

Starting targets to discuss, not requirements: Hit@5 ≥ 0.9 and zero leak-check failures before
moving to answer generation with real users. Leak checks must always pass.
