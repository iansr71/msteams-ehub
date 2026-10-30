# Citations

Phase 10 validates every claim and citation in a generated answer and builds the displayed
citations from trusted retrieval metadata. Code in `apps/api/src/rag/`:

| Module                     | Job                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `citationValidator.ts`     | Maps cited source IDs to chunks from this request and its courses; approves links      |
| `claimSupportValidator.ts` | Checks a claim's text against its cited chunks                                         |
| `citationBuilder.ts`       | Builds numbered citations and excerpts from retrieval metadata                         |
| `answerFormatter.ts`       | Chooses the displayed text and renders answers and citations                           |
| `answerSupportChecker.ts`  | Runs the steps below and decides between an answer and the insufficient-evidence reply |

## Citation fields

`citationId`, `chunkId`, `courseId`, `courseName`, `sectionName`, `moduleId`, `resourceId`,
`resourceName`, `resourceType`, `pageNumber`, `pageNumberEnd`, `slideNumber`, `sourceUrl`,
`excerpt`.

Every field is copied from the retrieved chunk. The model only supplies source IDs (`S1`,
`S2`…), so it cannot alter a document name, page, slide or link in a citation.

## Steps

1. **Map citations.** Each claim's source IDs are mapped to chunks retrieved for this request.
   An ID that was not provided is rejected (`citation_rejected`). A chunk from a course outside
   the request's courses is rejected too, and its content never appears in any citation or
   excerpt. Repeated IDs in a claim count once.
2. **Check each claim** against the chunks it validly cites. A claim is unsupported if:
   - it cites no valid chunk (`no_valid_citation`);
   - it mentions a page, or page range, outside every cited chunk's pages (`fabricated_page`);
   - it mentions a slide no cited chunk has (`fabricated_slide`);
   - it contains a link that is not one of its cited chunks' links (`fabricated_url`);
   - it names a file (`*.pdf`, `*.docx`, `*.pptx` …) that is not a cited resource
     (`fabricated_document`);
   - it states a number (`50`, `0.5`, `R1500`) that no cited chunk contains as digits or, for
     0-20, as a word (`unsupported_number`);
   - it shares no content word with its cited chunks (`no_overlap`).

   These checks are mechanical. They catch invented references and figures; they do not prove
   that a paraphrase means the same as its source.

3. **Remove unsupported claims.** If no claim is supported, or more claims were removed than
   kept, the answer is the insufficient-evidence reply. Otherwise the supported claims are kept
   (`unsupported_claims_removed`).
4. **Build citations** in order of first use: claims in order, each claim's chunks in the order
   cited. A chunk cited by several claims is one citation; claims list the citation numbers they
   use.
5. **Choose the text.** The model's prose is shown only if no claim was removed and the prose
   passes the same checks against all cited chunks. Otherwise the answer is rebuilt from the
   supported claims, each followed by its markers, e.g. `Reapply SPF 50 every two hours. [1]`
   (`answer_rebuilt_from_claims`).
6. **Final invariant.** `RagService` refuses to return anything that is neither the explicit
   insufficient-evidence reply nor an answer with at least one citation and every claim citing
   one (`invariant_violation`).

## Links

A citation's `sourceUrl` is the Moodle activity link (which enforces Moodle's own access), or the
file link if the activity link is not acceptable, and only if it is https, has no user name,
password or token-like query parameter, and its host is approved. Approved hosts come from
`CITATION_ALLOWED_HOSTS` (comma-separated), or the host of `MOODLE_BASE_URL` when unset. With
neither, citations carry no links (`source_link_withheld` warns when a link was withheld).

## Excerpts

Each citation carries the sentence of its chunk that best matches the claims citing it, cut to
`CITATION_EXCERPT_CHARS` (default 200), on one line, with control characters removed and secrets
redacted. Excerpts are only built from chunks within the request's courses.

## Change from phase 9

Phase 9 refused the whole answer when any claim lacked a source, and treated citations of unknown
source IDs as invalid model output (repair, then failure). Prompt 10 asks for unsupported claims to
be removed when the rest remains useful, so phase 10 removes them per the rules above, and an
unknown source ID now invalidates only the claims that rely on it.

## Commands

```bash
pnpm api ask --question "…" --course-id 12               # answer, claims with [n], Sources list
pnpm api ask --question "…" --course-id 12 --excerpts    # adds the excerpt under each source
pnpm evaluation answers --file tests/evaluation/retrieval-cases.json
```

`pnpm evaluation answers` runs each case through the full answer engine and fails a case when:

- an answer has no valid source and is not the explicit insufficient-evidence reply
  (`no_valid_source`; the summary line "Answers without a valid source" must be 0);
- a citation is outside the case's courses (`unauthorized_citation`) or a forbidden resource
  is cited (`forbidden_resource_cited`);
- the case lists expected resources and none is cited (`expected_resource_not_cited`), or the
  answer was refused (`unexpected_insufficient_evidence`);
- the case has `"expectInsufficientEvidence": true` but an answer was given.

Output holds statuses and IDs only, never questions, answers or excerpts. Exit code 1 if any case
fails.
