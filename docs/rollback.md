# Rollback

Getting back to the last version that worked. docs/infrastructure.md describes the mechanism;
this is the decision and the procedure, including what rolling back does _not_ undo.

Do this once against the real environment before go-live (checklist item 23 of
docs/production-deployment.md). A rollback that has never been run is not a plan.

## Decide what to roll back

| Symptom                                                        | Action                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| The new release answers badly, crashes, or fails its preflight | Roll the image back (below).                                                    |
| The new release is fine but a setting is wrong                 | Fix the setting and redeploy; a rollback would not change settings.             |
| Answers are wrong because Moodle content is wrong              | Not a release problem: docs/operations-runbook.md, procedure 13.                |
| A dependency is down (Moodle, Azure OpenAI, Search)            | Not a release problem: docs/incident-response.md. Rolling back will not fix it. |
| Something is unsafe and must stop now                          | Stop the bot first (below), then decide.                                        |

## Stopping answers immediately

Faster than any rollback, and the right first move when the question is "is this safe": scale the
bot to zero. Staff then get no reply in Teams rather than a wrong one.

```bash
az containerapp update --name <bot app> --resource-group <rg> \
  --min-replicas 0 --max-replicas 0
```

Removing the app from the pilot group's Teams permission policy has the same effect but takes
hours to propagate; the scale-to-zero is immediate. Restore with `--min-replicas 1
--max-replicas 1`.

## Rolling the image back

```bash
infrastructure/scripts/rollback.sh prod                      # the previous image in the history
infrastructure/scripts/rollback.sh prod --to-tag <tag>       # a specific image tag
```

It points the API, the bot and all three scheduled jobs at the earlier image, and takes a minute
or two. It refuses a tag that is not in the registry, and it asks for confirmation in production
unless `--yes` is given.

The rollback target is in the release report (`rollbackCommit`, and the image tag recorded with
the deployment). Pass `--to-tag` when you know which version you want rather than relying on
"the previous one": after an earlier rollback the revision history is no longer monotonic.

## What it does not roll back

- **Settings and secrets.** Only the image changes. If the release also changed a setting,
  redeploy the old commit instead: `deploy.sh prod --stage apps --image-tag <old tag>`, which
  puts the old template's settings and image back together.
- **The state on the file share.** An older image reading state that a newer one wrote is not
  verified release by release. Check the release notes; if the format changed, restore the state
  from the snapshot taken before the deployment (docs/backup-and-recovery.md).
- **The search index.** If the release changed the index schema, the old image may find the
  deployed index incompatible — `pnpm preflight` will say so. That is the case where the rollback
  is the index too: point `AZURE_SEARCH_INDEX_NAME` back at the previous index, which is why
  migrations create a new index rather than changing the old one in place
  (docs/operations-runbook.md, procedure 12).
- **The Teams app package.** The manifest lives in Teams, not in the container. If the release
  uploaded a new manifest, upload the previous package over it (docs/teams-deployment.md).
- **Moodle.** Nothing the assistant does changes Moodle, so there is nothing to undo there.

## After rolling back

1. `pnpm preflight` in the deployed environment: everything up, index schema compatible.
2. Ask a question in Teams and confirm an answer with working citation links.
3. Check the scheduled jobs are on the rolled-back image too (the script does them; confirm the
   next run succeeds rather than assuming).
4. **Pin the deployment.** The next `deploy.sh` run deploys whatever tag it is given, so pass
   `--image-tag <rolled-back tag>` until the fix is released, or the next deployment will quietly
   reinstate the broken version.
5. Write it up: what went wrong, what the rollback restored, what has to be true before trying
   again (docs/incident-response.md, docs/change-management.md).

## Rolling forward instead

Rolling back is the default because it is known-good. Roll forward with a fix only when the
rollback target cannot run — an incompatible index schema, or state the old image cannot read —
and then the fix goes through the same gates as any release: `pnpm release:verify`, then
`pnpm preflight` in the deployed environment. A hotfix that skipped the gates is how the next
incident starts.
