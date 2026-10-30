# Moodle synchronisation

Phase 11 keeps the search index in step with the selected Moodle courses. Code is in
`apps/indexer/src/jobs/` (the jobs and their pipeline) and `apps/indexer/src/state/` (the
synchronisation state store).

## Choosing the courses

Indexing is an explicit choice, never a default:

| Variable              | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `SYNC_COURSE_IDS`     | Comma-separated course IDs to index, e.g. `12,15,31`                      |
| `SYNC_ALL_COURSES`    | `true` to index every course the Moodle service account can see           |
| `SYNC_INCLUDE_HIDDEN` | `true` to also index content hidden from students (default `false`)       |
| `AZURE_TENANT_ID`     | Stamped on every chunk and part of every state key (same as other phases) |

Set one of the first two, not both. With neither, every `sync:*` command exits 2.

**Hidden content is excluded by default**: a hidden course, section, activity or Book chapter is
not indexed, and if it was indexed its chunks are removed the next time it is synchronised. The
reasoning: hidden content is usually a draft or retired material, and until phase 14 checks
enrolments, anything indexed can be retrieved by anyone with access to the course. Set
`SYNC_INCLUDE_HIDDEN=true` only if hidden content should be answerable.

## Pipeline

For every resource Moodle lists in a selected course:

```text
discover → compare state → download changed resources → extract → normalise → chunk → embed
  → replace resource chunks → update state
```

1. **Discover.** `core_course_get_courses` and `core_course_get_contents` (metadata only).
2. **Compare state** (`changeDetection.ts`, no downloads). A resource is processed when:
   - it is new, or returned after being removed or excluded;
   - Moodle's modification time or file size changed;
   - its citation metadata changed (course, section or activity name, file name, links);
   - the extractor that produced it has a new version;
   - the chunker version or the chunking settings changed (`CHUNK_*`, tokenizer);
   - the embedding model, `EMBEDDING_VERSION` or dimensions changed.

   Anything else is skipped.

3. **Download** with the Moodle token, and hash the bytes (SHA-256).
4. If the only reasons were "Moodle says it may have changed" and the file hash (or, after
   extraction, the content hash) equals what is indexed, nothing is re-indexed: the state records
   the new Moodle metadata and the resource is reported as `skipped` (`content_unchanged`).
5. **Extract, normalise, chunk, embed** with the phase 4-8 components. Embeddings come from the
   embedding cache when the chunk text is unchanged.
6. **Replace resource chunks** (below).
7. **Update state** for the resource.

## Replacing a resource "atomically"

Azure AI Search has no transactions. The replacement is as safe as the service allows:

- All new chunks are built and embedded **before** the index is touched. A failure during
  download, extraction, chunking or embedding leaves the indexed version untouched.
- Chunk keys are deterministic (tenant + course + resource + chunk number), so uploading
  **overwrites the previous version in place**: the resource stays searchable throughout, and a
  resource of up to `AZURE_SEARCH_BATCH_SIZE` chunks (500 by default) is replaced in a single
  indexing request.
- Only after every upload succeeded are leftover chunks removed (when the new version has fewer
  chunks than the old).
- If part of an upload fails, nothing is removed and the resource is marked for retry. Until the
  retry succeeds, the resource can have a mix of new and old chunks. This is the one window where
  search may show a mixture of versions.

## Resource states

| Status        | Meaning                                                        | Retried when                                                              |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `indexed`     | Chunks are in the index and match the recorded fingerprint     | Something in "compare state" changed                                      |
| `failed`      | Transient failure (Moodle, Azure OpenAI or Search unavailable) | After the backoff; at once by `sync:retry-failed` or if Moodle changes it |
| `dead_letter` | `SYNC_MAX_ATTEMPTS` transient failures in a row                | Moodle changes the resource, or `sync:retry-failed --include-dead-letter` |
| `quarantined` | Permanent failure (encrypted, corrupt, empty, unsupported…)    | Moodle changes the resource, or any extractor gets a new version          |
| `excluded`    | Hidden, or unsupported by discovery (e.g. `.xlsx`, folders)    | It becomes visible or supported                                           |
| `removed`     | Deleted from Moodle or its course is no longer selected        | It reappears in a selected course                                         |

Rules that matter operationally:

- **A transient failure never removes chunks.** The previous version stays searchable while
  retries run.
- **A permanent failure on a new version of a file removes the old chunks**, because they
  describe a file Moodle no longer serves. A permanent failure caused only by an extractor
  change (same file) keeps them.
- **Job-wide failures do not count as attempts.** Expired Moodle token, Azure authentication or
  authorisation errors, a missing index, a dimension mismatch, a damaged state file or
  cancellation stop the job immediately; no resource state changes, so an outage does not
  dead-letter the whole course.
- Backoff: `SYNC_RETRY_BASE_DELAY_MS` (10 minutes) doubling per attempt, at most
  `SYNC_RETRY_MAX_DELAY_MS` (24 hours).
- Failure categories are a fixed vocabulary (`moodle_unavailable`, `encrypted`,
  `index_partial_failure`…; full list in `state/syncState.ts`). Error messages, file contents and
  URLs with tokens are never stored.

## Deletions and reconciliation

- **Within a course**, every sync compares Moodle's listing with state and removes resources
  Moodle no longer lists.
- **`sync:full` and `sync:reconcile`** also list the index: chunks with no state at all (for
  example after the state store was lost) are removed when Moodle does not list their resource,
  and courses no longer selected (or, with `SYNC_ALL_COURSES`, no longer visible to the service
  account) are removed entirely.
- **A selected course Moodle does not return is not removed.** It is reported as `not_found`.
  A permission change on the service account can hide a course temporarily; deleting its content
  automatically would empty the index. Remove the ID from `SYNC_COURSE_IDS` to remove it.
- **Deletion guard.** If more than `SYNC_MAX_DELETE_FRACTION` (0.5) of a course's indexed
  resources would be removed as "deleted" in one run, and more than `SYNC_MAX_DELETE_MINIMUM` (5)
  of them, nothing is removed for that course, the report warns `deletion_guard`, and the job
  exits 1. The same applies to removing more than half of the indexed courses at once (more than
  one course). Check Moodle, then rerun with `--allow-mass-delete`. Hidden content is not
  guarded: hiding is an explicit Moodle setting.
- `sync:reconcile` downloads nothing. It removes deleted, hidden and unsupported content and
  orphaned chunks; it does not index changes.

## Concurrency and idempotency

- Every job takes a **lease per course** (`course:<tenant>:<courseId>`) in the state store before
  touching it, and renews it after each resource. A course leased by another job is reported as
  `locked` and skipped; `sync:resource` takes the same course lease, so a resource is never
  processed by two jobs at once. A lease left by a crashed job expires after
  `SYNC_LEASE_TTL_MS` (30 minutes).
- State writes are conditional (revision check), so a job whose lease expired and was taken over
  cannot overwrite newer state; the conflict is reported as `state_conflict` and the next run
  picks it up.
- Jobs are idempotent: state records what is indexed, unchanged resources are skipped, and chunk
  keys are deterministic, so re-running a job, or running it after a crash, converges on the
  same index without duplicates.

## Commands

```bash
pnpm indexer sync:incremental                     # what changed since the last run
pnpm indexer sync:full                            # everything, files verified by hash, deletions
pnpm indexer sync:course --course-id 12 [--verify]
pnpm indexer sync:resource --course-id 12 --resource-id 702:file:/Aftercare.pdf
pnpm indexer sync:retry-failed [--include-dead-letter]
pnpm indexer sync:reconcile --dry-run             # what would be removed
```

| Option                  | Commands                             | Effect                                                          |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `--dry-run`             | all                                  | Plan only: nothing is downloaded, indexed, removed or stored    |
| `--force`               | full, incremental, course, resource  | Reprocess every resource (still not hidden or unsupported ones) |
| `--allow-mass-delete`   | full, incremental, course, reconcile | Override the deletion guard                                     |
| `--verify`              | course                               | Download and hash every indexed file, as `sync:full` does       |
| `--include-dead-letter` | retry-failed                         | Also retry dead-lettered resources (resets their attempts)      |
| `--verbose`             | all                                  | List skipped resources too                                      |
| `--json`                | all                                  | The full report as JSON                                         |

Before a job starts, the command checks that the index exists with a compatible schema and that
the embedding dimensions match it (exit 1 with a hint otherwise). A dry run makes no downloads,
so it cannot know whether a changed timestamp hides an unchanged file: `would_index` is an upper
bound.

Exit codes: 0 when the job succeeded; 1 when any resource failed, a course was locked, not found
or failed, the deletion guard held, or the job stopped; 2 for usage errors and missing course
selection.

### Report

```text
Sync incremental: succeeded
  Job:        5f0c…
  Duration:   12.4 s
  Processed 48 | skipped 45 | updated 2 | removed 1 | failed 0

Courses
      12  synced

Resources
      12  indexed       702:file:/Aftercare.pdf [moodle_modified] chunks=6
      12  removed       601:page [deleted] chunks_removed=2
```

- **processed**: resources the job looked at; **skipped**: unchanged, not due, quarantined,
  already excluded; **updated**: (re)indexed; **removed**: chunks removed (deleted, hidden,
  unselected, orphaned); **failed**: failed, dead-lettered or quarantined this run.
- The report holds IDs, actions, reasons, categories and counts only: never document text,
  questions, error messages or credentials. Logs carry the job ID and the CLI's correlation ID.

### Suggested schedule

| When                 | Command             |
| -------------------- | ------------------- |
| Every hour           | `sync:incremental`  |
| Every 4 hours        | `sync:retry-failed` |
| Weekly, out of hours | `sync:full`         |

Phase 19 deploys these as scheduled jobs. Overlapping runs are safe (courses are leased).

## State store

`SyncStateRepository` (`state/syncStateRepository.ts`) is the only way the jobs read or write
state. Two implementations exist:

- `FileSyncStateRepository`: JSON files under `SYNC_STATE_DIR` (default `.ehub/sync-state`,
  git-ignored), one file per course plus `leases.json` and `jobs.json` (last 500 jobs). File
  locks and atomic renames make it safe for several processes **on one machine**. A damaged file
  is refused, never treated as empty (an empty state would re-index everything and could not
  detect deletions); restore it or move it aside, then run `sync:full`.
- `InMemorySyncStateRepository`: tests and single-process tools.

What is tracked per resource (`ResourceState`): tenant, course, resource and activity IDs;
status and reason; Moodle modification time and size as last observed; metadata hash; file and
content hash; the indexed fingerprint (Moodle time, hashes, extractor version, chunker version,
embedding model, version and dimensions, chunk count, indexing time); retry count, failure
category and next retry time; last job ID and type; last attempt and last successful index time.
Per job (`SyncJobRecord`): job ID and type, tenant, status, dry run, correlation ID, start and
finish time, courses and counts.

### Production implementations

Every implementation must pass `describeSyncStateRepositoryContract`
(`state/__fixtures__/syncStateRepositoryContract.ts`), run against an emulator or a test
database. Suggested layouts:

**Azure SQL / PostgreSQL**

```sql
CREATE TABLE sync_resource_state (
  tenant_id     varchar(128)  NOT NULL,
  course_id     integer       NOT NULL,
  resource_id   varchar(1100) NOT NULL,  -- index on a hash column if the engine limits key size
  status        varchar(16)   NOT NULL,
  next_retry_at timestamptz   NULL,
  state         jsonb         NOT NULL,  -- the validated ResourceState (nvarchar(max) on Azure SQL)
  revision      integer       NOT NULL,
  updated_at    timestamptz   NOT NULL,
  PRIMARY KEY (tenant_id, course_id, resource_id)
);
CREATE INDEX ix_sync_state_status ON sync_resource_state (tenant_id, status, next_retry_at);

-- saveResource(state, expected): INSERT … (revision 1) when expected is null, otherwise
-- UPDATE … SET revision = revision + 1 WHERE … AND revision = @expected; 0 rows → conflict.

CREATE TABLE sync_lease (
  name       varchar(300) PRIMARY KEY,
  owner      varchar(200) NOT NULL,
  token      varchar(64)  NOT NULL,
  expires_at timestamptz  NOT NULL
);
-- acquire: INSERT, or UPDATE … WHERE name = @name AND (expires_at <= now() OR owner = @owner).

CREATE TABLE sync_job (
  job_id      varchar(200) PRIMARY KEY,
  job_type    varchar(16)  NOT NULL,
  tenant_id   varchar(128) NOT NULL,
  status      varchar(32)  NOT NULL,
  started_at  timestamptz  NOT NULL,
  finished_at timestamptz  NULL,
  record      jsonb        NOT NULL
);
```

Use database time (`now()` / `SYSUTCDATETIME()`) for lease expiry, so clock skew between
workers cannot let two jobs hold a lease.

**Azure Table Storage**

| Table       | PartitionKey             | RowKey                       | Concurrency                                |
| ----------- | ------------------------ | ---------------------------- | ------------------------------------------ |
| `syncstate` | `<tenantId>\|<courseId>` | SHA-256 hex of `resourceId`  | `If-Match: <ETag>`; insert-only for create |
| `synclease` | `lease`                  | SHA-256 hex of lease name    | `If-Match: <ETag>`                         |
| `syncjob`   | `<tenantId>`             | inverted start time + job ID | none needed (one writer)                   |

RowKeys cannot contain `/`, `\`, `#` or `?`, and resource IDs can, hence the hash; store the
full resource ID as a property. The ETag is the revision.

## Tests

- `state/syncStateRepository.test.ts`: the repository contract for both implementations;
  concurrent creates across processes; damaged files; stale locks.
- `jobs/stateTransitions.test.ts`: every change-detection rule and state transition; failure
  classification.
- `jobs/syncJobs.test.ts`: the jobs end to end against a fake Moodle site (HTML Pages and PDFs),
  the real extractors, chunker and embedding provider, and a fake search service: skip unchanged,
  each reprocessing trigger, replacement order, deletions, hidden content, quarantine, retries
  and dead-lettering, partial index failures, job-wide failures, leases (in-process and between
  file-store handles), idempotency, dry runs, reconciliation and the deletion guard.
- `commands/syncCommands.test.ts` and `tests/integration/indexer-sync-cli.test.ts`: the CLI,
  exit codes and setup checks, the latter over HTTP(S) against fake Moodle, Search and OpenAI.
