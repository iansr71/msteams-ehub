# Grounded answers (RAG)

Phase 9 adds the answer engine in `apps/api/src/rag/`. It answers only from authorised E-Hub
passages and returns a structured result for citation validation (phase 10). Teams is not
connected yet.

| Component                 | Job                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ChatModelProvider`       | Interface for the chat model; `AzureOpenAIChatProvider` implements it                                                           |
| `QuestionNormalizer`      | NFC, control and bidirectional characters removed, whitespace collapsed; rejects empty or over-long questions (never cuts them) |
| `RetrievalOrchestrator`   | Hybrid retrieval within the authorised courses, then the support thresholds                                                     |
| `PromptBuilder`           | Fixed system rules; passages and question in delimited, defused tags; context budget                                            |
| `GroundedAnswerGenerator` | Structured output, Zod validation, one bounded repair attempt                                                                   |
| `AnswerSupportChecker`    | Refuses claims without sources, honours "insufficient evidence", removes unknown links                                          |
| `RagService`              | The whole flow, with the rate-limit hook and safe failures                                                                      |

## Flow

1. Validate the question length and the caller's context (tenant, user ID, authorised course
   IDs, optional selected courses).
2. Refuse before any retrieval when there are no authorised courses
   (`no_authorized_courses`) or a selected course is outside them (`course_not_authorized`).
3. Apply the rate-limit hook (`RagRateLimiter`; allow-all until phase 17).
4. Normalise the question without changing its meaning.
5. Embed the question and run filtered hybrid retrieval: tenant, active content and the
   authorised (or selected) courses are in the search filter, and vector search is
   pre-filtered.
6. Refuse below the support thresholds (`RAG_MIN_SUPPORTING_CHUNKS`, optional
   `RAG_MIN_TOP_RERANKER_SCORE`) without calling the model.
7. Build the prompt from the authorised retrieved chunks only, best first, within
   `RAG_MAX_CONTEXT_TOKENS` (estimated at 3 bytes per token; the best chunk is always included).
8. Generate a structured answer and validate it.
9. Return a `RagAnswer`.

## The model's answer

The model must return (and Azure structured outputs enforce, with `CHAT_RESPONSE_FORMAT=json_schema`):

```json
{
  "answer": "…",
  "claims": [{ "text": "…", "sourceIds": ["S1", "S3"] }],
  "insufficientEvidence": false,
  "conflictingSources": false,
  "warnings": []
}
```

Passages are labelled `S1`, `S2`… in the prompt. Validation (Zod) also checks what JSON Schema
cannot: at most 30 claims, each 1-1000 characters, source IDs that were actually provided,
and an answer within `RAG_MAX_ANSWER_CHARS`. On failure one repair request is sent, listing the
problems (field paths and rules, never content). If the second reply also fails, the result is
a safe failure, never a partial answer. A reply cut off at the token limit counts as invalid.

`RagAnswer` contains `status` (`answered`, `insufficient_evidence`, `failed`), the answer text
(or the fixed insufficient-evidence message, or a safe failure message), claims with the
**chunk IDs** they cite, the `insufficientEvidence` and `conflictingSources` flags, warnings,
the model's own warnings, the sources given to the model (metadata, no content), retrieval
statistics and timings.

Support checks applied before an answer is returned (phase 10 replaced these with the citation
validation in `docs/citations.md`; the summary below is kept for history):

- `insufficientEvidence: true` always yields the fixed message, whatever else the model wrote.
- An answer with no claims, or with any claim citing no source, is refused as insufficient.
- Links in the answer that no passage contains are replaced with `[link removed]`.
- `conflictingSources: true` adds a `conflicting_sources` warning; the answer describes the
  disagreement rather than resolving it.

## Untrusted content and prompt injection

- The system message is fixed text: the rules and the output contract. Nothing from the user or
  Moodle is ever placed in it.
- Passages and the question are in the user message inside `<source>` and `<question>` tags.
  Any `<source`, `</source`, `<sources`, `<question` and `</question` inside them is defused, so
  content cannot close its tag early, add a fake passage, or pose as instructions outside the
  tags. Control and bidirectional characters are removed.
- The rules tell the model that tagged text is data and that instructions inside it must be
  ignored.
- Whatever the model writes, a citation to a source that was not provided is rejected, links
  not present in any passage are removed, and unsupported claims are refused.

The unit tests prove the guardrails (tag defusing, fixed system message, rejection of invented
source IDs and links). Whether a particular model obeys the rules can only be shown against the
real model: run the live test and the evaluation set before each model change.

## Logging

Logs hold statuses, counts, warnings and durations. The question, the answer, passages and
model messages are never logged; errors carry the HTTP status and Azure's error code only.

## Configuration

| Variable                       | Default     | Notes                                                                     |
| ------------------------------ | ----------- | ------------------------------------------------------------------------- |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` | required    | Deployment name; endpoint, key and token scope are shared with embeddings |
| `CHAT_RESPONSE_FORMAT`         | json_schema | `json_object` for models without structured outputs                       |
| `CHAT_TEMPERATURE`             | not sent    | Set e.g. `0` for GPT-4o/4.1; reasoning models reject it                   |
| `CHAT_MAX_OUTPUT_TOKENS`       | 1200        | Sent as `max_completion_tokens`                                           |
| `CHAT_REQUEST_TIMEOUT_MS`      | 60000       | Per attempt                                                               |
| `CHAT_MAX_RETRIES`             | 2           | 408, 429, 5xx and connection resets only                                  |
| `RAG_MAX_QUESTION_CHARS`       | 1000        |                                                                           |
| `RAG_MAX_CONTEXT_TOKENS`       | 12000       | Estimated tokens of passages in the prompt                                |
| `RAG_MAX_ANSWER_CHARS`         | 4000        |                                                                           |
| `RAG_MIN_SUPPORTING_CHUNKS`    | 1           |                                                                           |
| `RAG_MIN_TOP_RERANKER_SCORE`   | off         | 0-4; fails closed when no reranker score exists                           |

Structured outputs (`json_schema` with `strict: true`) are supported on the Azure v1 API by
GPT-4o (2024-08-06 and later), GPT-4o-mini, GPT-4.1, GPT-5 and the o-series, per Microsoft's
documentation.

**Set `RAG_MIN_TOP_RERANKER_SCORE` after evaluation.** Hybrid retrieval always returns the
nearest neighbours, so for an off-topic question the chunk-count threshold rarely triggers and
the model alone decides whether the evidence is enough. A reranker threshold (with semantic
ranking on) adds a check that does not depend on the model. Pick the value from evaluation runs
of answerable and unanswerable questions.

The chat deployment's identity needs the **Cognitive Services OpenAI User** role, as for
embeddings.

## Command

```bash
pnpm api ask --question "How often should SPF be reapplied after a peel?" --course-id 12
pnpm api ask --question "…" --course-id 12,15 --selected-course-id 15 --json
```

`--course-id` is the authorised set (until phase 14 supplies it from Moodle enrolments);
`--selected-course-id` narrows within it. Embeddings are required, because answers always use
hybrid retrieval. Exit code 0 for an answer or insufficient evidence, 1 for a safe failure or an
error, 2 for usage errors. The answer and claims are printed (they are the command's output);
passages are not.

## Tests

- Unit: `apps/api/src/rag/rag.test.ts` (supported answer, unsupported answer, conflicting
  sources, injection in the question, injection in content, empty authorisation scope,
  malformed output, limits, logging) and `azureOpenAIChatProvider.test.ts` (request format,
  retries, no retry on 4xx, content filter, truncation, timeout, cancellation, redaction).
- Integration: `tests/integration/api-ask-cli.test.ts` runs `pnpm api ask` over HTTPS against
  fake search, embedding and chat services.
- Live (opt-in, synthetic passages only):

  ```bash
  EHUB_LIVE_CHAT_TESTS=1 pnpm vitest run --project integration tests/integration/azure-openai-chat-live.test.ts
  ```
