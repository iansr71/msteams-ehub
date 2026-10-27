# Content extraction

Phase 4 turns a downloaded Moodle resource into normalised text blocks with location metadata.
Code: `apps/indexer/src/extractors/`. Nothing is stored yet; chunking (phase 5) and indexing
(phase 6) consume the results.

## Supported content

| Priority | Content                   | Extractor     | Location metadata kept                             |
| -------- | ------------------------- | ------------- | -------------------------------------------------- |
| 1        | PDF                       | `pdf`         | Page number; headings inferred from font size      |
| 1        | Moodle Page               | `moodle-page` | Heading hierarchy rooted at the Page name          |
| 1        | Moodle Book chapter       | `moodle-book` | Heading hierarchy rooted at [Book, chapter title]  |
| 1        | Plain text                | `plain-text`  | Paragraphs                                         |
| 1        | HTML file                 | `html`        | Heading hierarchy                                  |
| 2        | Word (.docx, .dotx)       | `docx`        | Heading hierarchy (outline level or heading style) |
| 2        | PowerPoint (.pptx, .ppsx) | `pptx`        | Slide number; slide title as heading; notes        |

Every result carries: course ID and name, section ID and name, module ID and name, resource
ID, name and type, file name, detected and declared MIME type, token-free source URL and
Moodle activity URL (for citations), modified timestamp, byte length, text blocks, content
hash, warnings and extractor name/version.

Text blocks are `heading`, `paragraph`, `list-item`, `table-row` (cells joined with `|`),
`preformatted` or `speaker-notes`, each with its heading path and page or slide number.

## How a resource is processed

1. **Size check**: input over `EXTRACTION_MAX_INPUT_BYTES` fails as `input_too_large` before
   any parsing.
2. **Independent type detection** from the bytes (`contentTypeDetector.ts`). The file name
   and the declared MIME type are never trusted. PDF by signature; ZIP packages by their
   `[Content_Types].xml` main part; OLE containers (legacy or encrypted Office); then text
   versus HTML. A declared type naming a _different_ supported type adds the warning
   `declared_type_mismatch`, and the detected type wins.
3. **Extractor selection** by detected type and Moodle role (Page body, Book chapter, file).
4. **Extraction** under the limits below.
5. **Normalisation**: NFC, control/zero-width/bidi characters removed, whitespace collapsed
   (line structure kept for preformatted text).
6. **Content hash**: SHA-256 over the normalised blocks (see below).

`ExtractorRegistry.extract()` never throws for document problems. It always returns one of:

| Status        | Meaning                            | Reasons                                                                                                                            |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `extracted`   | Text blocks produced               | —                                                                                                                                  |
| `unsupported` | Not a type this phase handles      | `unsupported_content_type`, `macro_enabled_document`, `legacy_office_format`, `no_extractor`                                       |
| `failed`      | A supported type could not be read | `encrypted`, `corrupt`, `empty`, `timeout`, `input_too_large`, `archive_limit_exceeded`, `unsafe_archive_entry`, `extractor_error` |

Failure results never include parser error messages, which can quote document content.

## Safety measures

| Threat                                  | Measure                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Script / active content in HTML         | Parsed into an inert tree (htmlparser2); nothing is rendered or executed                                      |
| Scripts, styles, embedded objects       | `script`, `style`, `iframe`, `object`, `embed`, `svg`, `template`, forms and media dropped with their subtree |
| Navigation and hidden text              | `nav`, navigation roles, breadcrumbs, `hidden`, `aria-hidden`, `display:none` dropped                         |
| Hidden text in Word                     | Runs marked hidden (`w:vanish`), tracked deletions and field codes skipped (`hidden_text_skipped`)            |
| Macros                                  | Macro-enabled packages (by content type or `vbaProject.bin`) refused as `macro_enabled_document`              |
| External references                     | Never fetched: external relationships ignored, links and images not followed, no network access at all        |
| PDF code execution                      | pdfjs 6 contains no evaluation of document-derived code (guarded by `tests/security/pdf-parser.test.ts`)      |
| PDF fonts / XFA / range fetching        | `disableFontFace`, `enableXfa: false`, `disableRange`, `disableStream`, `disableAutoFetch`                    |
| XML entity expansion ("billion laughs") | Any `DOCTYPE` in an OOXML part is rejected; only predefined entities exist                                    |
| Deep XML nesting                        | Maximum depth 256                                                                                             |
| Path traversal / unsafe archive names   | Absolute paths, `..`, `.`, empty segments, backslashes, drive letters and NUL refused; whole archive rejected |
| Decompression bombs                     | Per-entry and total inflated-byte limits counted while streaming; suspicious compression ratio refused        |
| Lying ZIP headers                       | Inflated bytes checked against declared sizes while streaming                                                 |
| Prompt injection inside documents       | Extracted text is data only; it is never executed or interpreted as instructions (enforced again in phase 9)  |
| Native code in the parser path          | `@napi-rs/canvas` (pdfjs rendering only) is excluded via `ignoredOptionalDependencies`                        |

Parser versions are pinned exactly (`pdfjs-dist`, `yauzl`, `saxes`, `htmlparser2`) so upgrades
are deliberate.

## Limits

| Variable                            | Default   | Meaning                                                     |
| ----------------------------------- | --------- | ----------------------------------------------------------- |
| `EXTRACTION_MAX_INPUT_BYTES`        | 50 MiB    | Largest file accepted for extraction                        |
| `EXTRACTION_MAX_TEXT_CHARS`         | 2,000,000 | Extracted text is cut here, with warning `text_truncated`   |
| `EXTRACTION_TIMEOUT_MS`             | 60,000    | Time limit per resource, including type detection           |
| `EXTRACTION_MAX_ARCHIVE_ENTRIES`    | 2,000     | Entries in a DOCX/PPTX package                              |
| `EXTRACTION_MAX_UNCOMPRESSED_BYTES` | 200 MiB   | Total bytes inflated from one package                       |
| (fixed)                             | 100 MiB   | Largest single package entry read                           |
| (fixed)                             | 200 : 1   | Compression ratio above which an entry (> 1 MiB) is refused |

The download itself is also bounded by `MOODLE_MAX_DOWNLOAD_BYTES` and
`MOODLE_DOWNLOAD_TIMEOUT_MS` (phase 2).

### Timeouts

The time limit is enforced in two ways: a hard race that abandons the extraction and reports
`timeout`, and cooperative checks between units of work (pages, slides, archive entries, every
few thousand XML events or HTML nodes). A single synchronous parser call cannot be pre-empted
inside the Node.js process. Input size limits keep such calls short in practice; running
extraction in a separate worker or process with memory limits is the planned hardening for
phase 17.

## Content hash

`computeContentHash()` hashes a version prefix and one JSON line per block:
`[kind, headingLevel, pageNumber, slideNumber, headingPath, text]`. So:

- the same document gives the same hash, run after run;
- changing text, order, page or slide placement changes the hash;
- an extractor upgrade that yields identical text does **not** change the hash. The extractor
  version is recorded separately, so phase 11 can choose to re-extract after an upgrade.

## Heuristics and known limitations

- **PDF headings** are inferred from font size: lines at least 1.2 times the dominant body
  size, up to 150 characters, become headings (largest size = level 1, up to level 3). Bold
  body-size headings are not detected. Multi-column layouts may interleave columns.
- **Scanned PDFs** have no text layer. They produce `pages_without_text`, or `failed / empty`
  if no page has text. OCR is out of scope.
- **Encrypted PDFs** with a user password fail as `encrypted`. PDFs with only permission
  restrictions (owner password) open normally.
- **Word**: headers, footers, footnotes, comments and text in embedded objects are not
  extracted. Nested tables are folded into the enclosing cell.
- **PowerPoint**: hidden slides are skipped (`hidden_slides_skipped`) but keep their numbering.
  Charts, SmartArt and text inside images are not extracted.
- **Legacy formats** (.doc, .ppt) are `unsupported / legacy_office_format`. Convert them in Moodle.
- **Text encodings**: UTF-8 and UTF-16 (with BOM) are supported; other text is decoded as
  Windows-1252 with warning `decoded_as_windows_1252`.

## Trying it against Moodle

```bash
# Find resource IDs
pnpm -s indexer moodle:inspect --course-id 12 --json | jq -r '.resources[].resourceId'

# Download and extract one resource
pnpm -s indexer extract:test --course-id 12 --resource-id '501:file:/checklist.pdf'
pnpm -s indexer extract:test --course-id 12 --resource-id 601:page --json
pnpm -s indexer extract:test --course-id 12 --resource-id 701:chapter:11 --no-preview
```

Output contains sanitized metadata, counts, the content hash, warnings and a preview of at most
300 characters (`--no-preview` turns it off). The extracted document is never printed, logged
or written to disk. Exit code `0` means extracted, `1` unsupported or failed, `2` usage error.

## Fixtures

Binary fixtures in `apps/indexer/src/extractors/__fixtures__/` contain invented sample text and
are generated by `scripts/fixtures/generate_extraction_fixtures.py` (reportlab, pypdf,
python-docx, python-pptx, msoffcrypto-tool). Hostile archives (traversal, bombs, lying headers,
macros, DOCTYPE entities) are built byte-for-byte in the tests with `buildZip()`.
