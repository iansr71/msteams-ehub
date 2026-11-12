# Backup and recovery

What is worth backing up, what is cheaper to rebuild, and how to prove a restore works before
needing it.

## What state exists

| State                                                                | Where                                           | Backup                                                    | If it is lost                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Sync state (what is indexed, fingerprints, failures, leases)         | Azure Files share `state`, at `/mnt/state/sync` | Share snapshots; soft delete for deleted shares and files | Rebuildable: the next `sync:full` re-reads Moodle and re-indexes everything. Costs a full re-embed.                      |
| Identity mappings (Entra user → Moodle account, and denied attempts) | `/mnt/state/identity`                           | Same share                                                | Explicit mappings are lost and automatic matching resumes; the few people who needed a manual mapping need it again.     |
| Administration audit and answer outcomes                             | `/mnt/state/admin`                              | Same share                                                | The audit trail is gone. Not rebuildable, which is why it is worth a snapshot.                                           |
| Search index (chunks, vectors, metadata)                             | Azure AI Search                                 | None                                                      | Rebuildable from Moodle: `sync:full --force`. There is no point backing up derived data.                                 |
| Secrets                                                              | Key Vault                                       | Soft delete, and purge protection in production           | Recoverable within the retention window; otherwise reissue the Moodle token and the bot secret (docs/token-rotation.md). |
| Container images                                                     | Azure Container Registry                        | The registry keeps every pushed tag                       | Rebuildable from the source commit. The release report's checksums identify what was deployed.                           |
| Teams app packages and release reports                               | Blob container `releases`                       | Soft delete                                               | Rebuildable from the tagged commit with `pnpm teams:package`.                                                            |
| The source                                                           | GitHub (`iansr71/msteams-ehub`)                 | GitHub, plus every clone                                  | —                                                                                                                        |
| Moodle content                                                       | The Moodle server                               | Moodle's own backups, which are not this project's        | Everything the assistant knows comes from here. This is the backup that actually matters.                                |

The useful summary: **the only state that cannot be rebuilt is the administration audit trail and
the explicit identity mappings.** Everything else is derived from Moodle and the source.

## Setting the backups up

1. **File share snapshots.** On the storage account's `state` share, add a snapshot policy — a
   daily snapshot kept for 30 days is proportionate. Snapshots are cheap because the share is
   small (sync state and audit records, no content).
2. **Soft delete** is on already, from the Bicep: deleted shares, files, blobs and containers are
   recoverable for the configured retention (`softDeleteRetentionDays`).
3. **Key Vault** has soft delete, with purge protection in production, so a deleted secret can be
   recovered and cannot be purged early.
4. **No backup of the search index.** Deliberate. It is derived data and a rebuild is a known,
   tested procedure.

## Restoring the sync state

When the state is lost or corrupted — a deleted share, or a state directory that no longer parses.

```bash
# 1. Stop any job execution that is running, so nothing writes while you restore.
az containerapp job stop --name caj-<base>-sync --resource-group <rg>

# 2. Restore the share, or the directory, from the most recent snapshot
#    (portal: the share → Snapshots → Restore).

# 3. Check what the restored state thinks is indexed.
pnpm indexer sync:incremental --dry-run
```

`az containerapp job stop` ends executions that are running; it does not cancel the schedule. Do
the restore in the gap between scheduled runs — the sync runs at 01:15 and the reconcile weekly —
or, if you need longer, change the cron parameter and deploy, which is a change rather than a
console action. A job that does start mid-restore fails and retries on its next run rather than
corrupting anything: each course is held under a lease (docs/sync.md).

If the snapshot is older than the last sync, the dry run will show resources it believes are
unindexed; let the next incremental run deal with them.

If there is no usable snapshot, do not try to repair the state by hand. Delete it and rebuild:

```bash
pnpm indexer sync:full --force
```

That re-reads every selected course, re-extracts, re-embeds and re-indexes. It costs embedding
calls and time, not correctness — the index ends up the same.

## Rebuilding the search index

When the index is deleted, damaged, or being replaced for a schema or embedding migration.

```bash
pnpm indexer search:create-index          # creates it if missing; never deletes
pnpm indexer sync:full --force            # re-index everything from Moodle
pnpm indexer search:health                # document count
pnpm evaluation:retrieval                 # prove retrieval before staff use it
```

Staff see insufficient-evidence replies while the index is empty. They do not see wrong answers,
which is the behaviour to rely on here: an empty index means no grounded sources, so there is no
answer rather than an invented one.

## Recovering a deleted secret

```bash
az keyvault secret recover --vault-name <vault> --name moodle-token
```

Within the retention window this restores it with its versions. Afterwards, reissue instead
(docs/token-rotation.md).

## Proving it, before go-live

Checklist item 22 of docs/production-deployment.md is this test, and it is not optional:

1. Confirm a snapshot of the `state` share exists.
2. Restore that snapshot to a new share and confirm `sync:incremental --dry-run` reads it
   (pointing `SYNC_STATE_DIR` at the restored copy, in a test environment).
3. Delete a single indexed resource's chunks and recover them with
   `pnpm indexer sync:resource --course-id <id> --resource-id <id> --force`.
4. Record the date and the outcome in the deployment record.

A backup nobody has restored is a hypothesis.

## Recovery objectives

Worth agreeing explicitly, because they drive how much of the above matters:

| Scenario                             | How long                   | What is lost                                                                            |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------- |
| Bad release                          | Minutes (docs/rollback.md) | Nothing.                                                                                |
| State share lost, snapshot available | Under an hour              | Changes since the snapshot, which the next sync re-does.                                |
| State share lost, no snapshot        | A few hours (`sync:full`)  | The audit trail and explicit identity mappings.                                         |
| Search index lost                    | A few hours (`sync:full`)  | Nothing permanent; answers are unavailable until it refills.                            |
| Azure region unavailable             | Not covered                | The assistant is unavailable. Moodle is unaffected, so staff fall back to E-Hub itself. |

A region failure has no automatic failover, and a pilot does not need one. Say so out loud rather
than implying a resilience that was never built: the fallback is that staff use Moodle directly,
as they did before the assistant existed.
