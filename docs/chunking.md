# Chunking

Phase 5 turns one extracted resource into `ContentChunk` records ready for indexing (phase 6).
Code: `apps/indexer/src/pipeline/`. Nothing is indexed or stored in this phase.

```
ExtractionResult ─▶ normalizeContent ─▶ StructuredChunker ─▶ ContentChunk[]
                    (units, furniture    (boundaries, sizes,   (metadata, IDs,
                     removal, context)    overlap)              validation)
```

## Settings

| Variable               | Default       | Meaning                                                                 |
| ---------------------- | ------------- | ----------------------------------------------------------------------- |
| `CHUNK_TARGET_TOKENS`  | 850           | Size the packer aims for                                                |
| `CHUNK_MAX_TOKENS`     | 1000          | Hard ceiling; no chunk is ever larger (including overlap)               |
| `CHUNK_MIN_TOKENS`     | 100           | Below this, a group may merge across a heading or page boundary         |
| `CHUNK_OVERLAP_TOKENS` | 125           | Most text repeated from the previous chunk                              |
| `CHUNK_TOKENIZER`      | `cl100k_base` | `cl100k_base` (text-embedding-3 models) or `o200k_base` (GPT-4o family) |

Validation requires `1 <= min < target <= max` and `overlap <= target / 2`; problems are
reported by variable name. Tokens are counted with a real BPE tokenizer (`js-tiktoken`), not
estimated from characters.

## Boundaries

Every gap between two pieces of content has a strength. From strongest to weakest:

| Strength | Boundary                                    | Policy                                                              |
| -------- | ------------------------------------------- | ------------------------------------------------------------------- |
| —        | Moodle resource                             | Absolute: each resource is chunked separately                       |
| 8        | PowerPoint slide                            | Always split; never merged, even when tiny                          |
| 7        | Document section (shallowest heading level) | Always split; never merged, except a heading left without content   |
| 6        | Heading                                     | Always split; merged back only when one side is below the minimum   |
| 5        | PDF page                                    | Always split; merged back only when one side is below the minimum   |
| 4        | Paragraph                                   | Used only when a group exceeds the maximum; packed up to the target |
| 3        | List item / table row                       | As paragraph, so lists stay together where they fit                 |
| 2        | Sentence (inside an oversized block)        | As paragraph                                                        |
| 1        | Word run or token run                       | Last resort for text with no sentence boundary (e.g. a huge URL)    |

The algorithm applies the structural levels (8–5) first, then the packing levels (4–1) only to
groups still larger than `CHUNK_MAX_TOKENS`. Consequences:

- a chunk never mixes resources or slides, and only mixes PDF pages when a page is tiny
  (the chunk records `pageNumber` and `pageNumberEnd`);
- a heading is never emitted alone: it always travels with the content that follows it;
- one oversized paragraph is split at sentence boundaries; a sentence longer than a chunk is
  split between words; only a run with no spaces at all is cut by tokens;
- a tiny trailing group is folded into the previous chunk when it fits.

## Overlap

A chunk starts with up to `CHUNK_OVERLAP_TOKENS` tokens from the end of the previous chunk,
only when both continue the same section, heading, page and slide (a paragraph-level or weaker
boundary). Overlap is made of whole trailing sentences where possible, is never more than half
the previous chunk, and is reduced so the chunk stays within the maximum. `overlapTokens` on each
chunk says how much of `content` is repeated. A new section never repeats the previous one.

## ContentChunk

| Field                                                                | Notes                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chunkId`                                                            | SHA-256 (hex) of tenant, course, resource ID and chunk number. Position-based: re-chunking a changed resource gives the same IDs for the same positions, so updates overwrite in place and only surplus chunks need deleting. Valid as an Azure AI Search key. |
| `tenantId`                                                           | Entra tenant ID (`AZURE_TENANT_ID`).                                                                                                                                                                                                                           |
| `courseId`, `courseName`, `courseCategory`                           | `courseCategory` is the Moodle category **ID** as a string (see limitations).                                                                                                                                                                                  |
| `sectionId`, `sectionName`, `moduleId`, `moduleName`                 | From discovery.                                                                                                                                                                                                                                                |
| `resourceId`, `resourceName`, `resourceType`, `fileName`, `mimeType` | From extraction (detected MIME type).                                                                                                                                                                                                                          |
| `title`, `headingPath`                                               | Heading context of the chunk's first piece; `title` is its last heading or the resource name.                                                                                                                                                                  |
| `content`                                                            | Light markup: `#` headings, `- ` list items, `Speaker notes:` prefix; overlap first.                                                                                                                                                                           |
| `pageNumber`, `pageNumberEnd`, `slideNumber`                         | Location for citations.                                                                                                                                                                                                                                        |
| `chunkNumber`, `chunkCount`                                          | 1-based position and total within the resource.                                                                                                                                                                                                                |
| `tokenCount`, `overlapTokens`                                        | Exact counts (see "Long unbroken runs").                                                                                                                                                                                                                       |
| `sourceUrl`, `moduleUrl`                                             | Token-free file URL; Moodle activity URL for citations.                                                                                                                                                                                                        |
| `contentHash`                                                        | SHA-256 of this chunk's content.                                                                                                                                                                                                                               |
| `sourceContentHash`                                                  | Extraction hash of the whole resource, for change detection (phase 11).                                                                                                                                                                                        |
| `modifiedAt`, `indexedAt`                                            | Moodle modification time; time of chunking (injected clock).                                                                                                                                                                                                   |
| `extractorVersion`, `chunkerVersion`                                 | e.g. `pdf@1.0.0`, `structure-aware@1.0.0`.                                                                                                                                                                                                                     |
| `allowedUserIds`, `allowedGroupIds`                                  | Filled from Moodle enrolments in phase 14. **Empty means nobody**: retrieval must deny a chunk with no allowed users or groups.                                                                                                                                |
| `isActive`                                                           | `true` when created; phase 11 deactivates removed content.                                                                                                                                                                                                     |

Every chunk is validated against `contentChunkSchema` (Zod) before it is returned.

## Normalisation

- Blocks become units with light markup and their heading context.
- **PDF page furniture** is removed: short paragraphs (≤ 120 characters) that appear on at least
  3 pages and at least half of all pages, such as running headers and "Confidential" footers,
  plus lines that are only page numbers ("4", "Page 4 of 10").
- An immediately repeated block at the same location is dropped once.

## Long unbroken runs

The JavaScript BPE tokenizer is quadratic in the length of an unbroken run of repetitive
characters (a 4,000-character run of one letter takes about 1.7 s), and documents are untrusted.
Runs longer than 64 non-space characters are therefore counted as their UTF-8 byte length
instead of being encoded. That is an upper bound (every token covers at least one byte), so it
can only make chunks smaller, never larger. Ordinary text, including typical URLs, is counted
exactly. Strings such as `<|endoftext|>` in documents are treated as text, never as special
tokens.

## Determinism and versioning

The same extracted document and settings always produce the same chunks, IDs and hashes:
there is no randomness, and `indexedAt` comes from an injected clock. Sentence boundaries come
from `Intl.Segmenter`, so a Node.js upgrade that changes ICU data could move a boundary; the
`chunkerVersion` and the content hashes make such a change visible. Bump `CHUNKER_VERSION`
(`chunkMetadata.ts`) whenever the algorithm changes boundaries.

## Trying it against Moodle

```bash
pnpm -s indexer chunk:test --course-id 12 --resource-id '501:file:/checklist.pdf'
pnpm -s indexer chunk:test --course-id 12 --resource-id 601:page --json
pnpm -s indexer chunk:test --course-id 12 --resource-id 701:chapter:11 --preview
```

Output shows chunk numbers, token counts, overlap, page or slide, a truncated heading path and
a short chunk ID. Chunk text is not shown; `--preview` adds the first 60 characters of each
chunk. Nothing is indexed. Exit code `0` means chunks were produced, `1` unsupported, failed
or empty, `2` usage error.

## Known limitations

- `courseCategory` holds the category **ID**. Category names need `core_course_get_categories`,
  which is not on the restricted service's function list; adding it is a decision for the
  Moodle administrator.
- PDF heading detection is font-size based (see `docs/extraction.md`), so PDF chunk boundaries
  are only as good as those headings.
- Chunk content does not repeat the heading breadcrumb inside continuation chunks; the context
  is in `headingPath` and `title`, which phase 8 combines with `content` for embedding.
