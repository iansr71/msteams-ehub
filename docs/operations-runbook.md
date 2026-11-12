# Operations runbook

The procedures a single administrator runs to keep the assistant working. Each one says when to
use it, the exact commands, and how to tell it worked. Incidents are docs/incident-response.md;
staff-reported problems are docs/support-troubleshooting.md.

Run the commands with the deployed environment's configuration: from a Container Apps console
session in the API or jobs app, or from a machine holding
`infrastructure/environments/prod.env` and able to reach Azure and Moodle. Secrets stay in Key
Vault either way.

## What runs by itself

| Job                     | Schedule (prod default) | What it does                                                                                                  |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `caj-<base>-sync`       | `15 1 * * *`            | `sync:incremental` — indexes what changed in the selected courses.                                            |
| `caj-<base>-enrolments` | `40 */4 * * *`          | `authorization sync` — re-checks every known user's Moodle enrolments and revokes cached access that changed. |
| `caj-<base>-reconcile`  | `45 2 * * 0`            | `sync:reconcile` — removes chunks of deleted, hidden or deselected content.                                   |

The schedules are Bicep parameters (`incrementalSyncCron`, `enrolmentSyncCron`,
`reconcileCron`). Changing one is a deployment, not a console action.

## Daily and weekly checks

```bash
pnpm preflight            # everything, including the live dependencies and the index schema
pnpm diagnose             # the same live checks plus sync lag, as JSON
```

Weekly: skim the sync job's last run, the failed-resource count, and the answer outcomes in the
administration area (docs/admin.md). Monthly: check how close `MOODLE_TOKEN_EXPIRES_ON` is.

---

## 1. Re-index one resource

When one document is wrong, missing or stale and you do not want to touch anything else.

```bash
pnpm indexer sync:resource --course-id 12 --resource-id "701:chapter:11" --dry-run
pnpm indexer sync:resource --course-id 12 --resource-id "701:chapter:11"
```

`--force` re-indexes even when nothing appears to have changed, which is what you want after
fixing an extraction problem rather than a content one.

_Worked when:_ the report shows `action: indexed` with a chunk count, and
`pnpm api retrieve --question "<phrase from the new text>" --course-id 12` returns it.

## 2. Re-index one course

After a bulk edit in Moodle, or when a course's answers look generally out of date.

```bash
pnpm indexer sync:course --course-id 12 --dry-run
pnpm indexer sync:course --course-id 12
pnpm indexer sync:course --course-id 12 --verify   # also re-downloads and re-hashes every file
```

`--verify` is the slow, thorough form: use it when you suspect a file changed in Moodle without
its modification time changing.

_Worked when:_ `counts.failed` is 0 and the resources you expected appear as `indexed` or
`skipped`.

## 3. Run an incremental sync now

When a change in Moodle is needed before the nightly run.

```bash
pnpm indexer sync:incremental --dry-run
pnpm indexer sync:incremental
```

_Worked when:_ the report's status is `succeeded` and the changed resources show as `indexed`.
`completed_with_failures` means some resources failed; see procedure 5.

## 4. Run a full reconciliation

When content was deleted or hidden in Moodle and may still be answerable, or after changing the
course selection.

```bash
pnpm indexer sync:reconcile --dry-run      # always first: it lists what would be removed
pnpm indexer sync:reconcile
```

The deletion guard refuses a removal that would take out more than `SYNC_MAX_DELETE_FRACTION` of
a course's resources, which is what stops a Moodle outage from emptying the index. If the guard
fires and the removal really is correct, re-run with `--allow-mass-delete` — after reading the
dry run, not instead of it.

Reconciliation with no courses selected is refused outright, so an empty `SYNC_COURSE_IDS` cannot
wipe the index.

_Worked when:_ the removed resources are gone from `pnpm indexer search:health`'s document count
and a question about the withdrawn content returns insufficient evidence.

## 5. Retry failed resources

A transient failure (a Moodle timeout, a rate limit) is retried automatically with backoff, up to
`SYNC_MAX_ATTEMPTS`, after which the resource is dead-lettered and left alone.

```bash
pnpm indexer sync:retry-failed                          # ignores the backoff, skips dead letters
pnpm indexer sync:retry-failed --include-dead-letter    # after fixing the underlying cause
```

_Worked when:_ the entries show `indexed`, and the failed count in `pnpm diagnose` drops. A
resource that fails permanently (an encrypted PDF, say) is quarantined on purpose; fix it in
Moodle or accept that it is not answerable.

## 6. Refresh enrolments

When someone's Moodle enrolment changed and the assistant has not noticed yet. Cached decisions
live for `AUTHZ_CACHE_TTL_SECONDS`, and the enrolment job re-checks everyone every four hours.

```bash
pnpm authorization courses --entra-object-id <guid>      # straight from Moodle, cache bypassed
pnpm authorization invalidate --entra-object-id <guid>   # re-check this person on their next question
pnpm authorization invalidate --all                      # re-check everyone
pnpm authorization sync                                  # re-check now and revoke what changed
```

_Worked when:_ `courses` shows the expected course list and the person's next question behaves
accordingly.

## 7. Resolve a user's identity mapping

When someone signs in but the assistant cannot tell which Moodle account they are — the usual
cause of "I could not confirm what you have access to" for one person only.

```bash
pnpm identity resolve --entra-object-id <guid>    # dry run: shows what matching would decide
pnpm identity failures                            # denied mappings, newest first
pnpm identity map --entra-object-id <guid> --moodle-user-id <id>   # approve explicitly
pnpm identity unmap --entra-object-id <guid>      # back to automatic matching
```

Map explicitly only when you have confirmed the two accounts are the same person. An approved
mapping grants that person everything the Moodle account can read (docs/authorization.md).

_Worked when:_ `resolve` names the Moodle account and the person's next question is answered.

## 8. Revoke a user's access

Leavers and anyone whose access must stop now.

1. The real revocation is in Moodle and Entra: remove the Moodle enrolments, or disable the Entra
   account. Either one ends access.
2. Make the assistant act on it immediately rather than at the next cache expiry:

```bash
pnpm authorization invalidate --entra-object-id <guid>
pnpm identity unmap --entra-object-id <guid>    # if an explicit mapping existed
```

3. Remove them from the pilot group so the app disappears from their Teams
   (docs/teams-deployment.md).

_Worked when:_ `pnpm authorization courses --entra-object-id <guid>` returns no courses, or the
identity no longer resolves, and a question from that account is refused. A disabled Entra
account fails at sign-in before the API is reached at all.

## 9. Rotate the Moodle token

docs/token-rotation.md. Summary: issue the new token alongside the old, add a new version of the
`moodle-token` secret in Key Vault, update `MOODLE_TOKEN_EXPIRES_ON`, redeploy the same image tag
so the revisions pick it up, prove it with `pnpm preflight`, then delete the old token.

## 10. Change the chat model deployment

A new model version, or a different deployment name.

1. Create the new deployment in Azure OpenAI. Leave the old one in place.
2. Change `AZURE_OPENAI_CHAT_DEPLOYMENT` (`EHUB_OPENAI_CHAT_DEPLOYMENT` in the environment file)
   and deploy.
3. Prove it: `pnpm preflight` shows `chat: pass`, then `pnpm evaluation:answers` against the
   deployment.
4. Keep the old deployment until the evaluation looks right — reverting is a parameter change
   back, not a rebuild.

The index is unaffected: the chat model does not touch embeddings. Expect wording and hedging to
change, which is exactly what the answer evaluation is for (docs/acceptance.md).

## 11. Migrate the embedding model

This one is a re-index, not a setting change: vectors from different models are not comparable.

1. Create the new embedding deployment.
2. Decide the target index. For a dimension change you need a new index: set
   `AZURE_SEARCH_INDEX_NAME` to a new name and `AZURE_SEARCH_VECTOR_DIMENSIONS` to the new size.
3. Deploy with the new embedding deployment and index name, then
   `pnpm indexer search:create-index`.
4. `pnpm indexer sync:full --force` to re-embed and re-index everything into the new index.
5. `pnpm evaluation:retrieval` against the new index before switching staff onto it: retrieval
   quality is what changes here.
6. The old index stays until you delete it, so the rollback is to point the API's index name
   back.

If the dimensions are unchanged, bumping `EMBEDDING_VERSION` is enough to make the fingerprint
change and force a re-embed into the same index, but then there is no second index to fall back
to — prefer the new-index route in production.

## 12. Migrate the search index schema

```bash
pnpm indexer search:validate-index                               # what differs, if anything
pnpm indexer search:create-index --apply-compatible-changes      # applies what Azure allows in place
```

`incompatible` means Azure cannot change the deployed index in place — a field's type or a
vector's dimensions. Then it is the new-index route: new `AZURE_SEARCH_INDEX_NAME`, create,
`sync:full --force`, evaluate, switch, delete the old index later.

`pnpm preflight` fails while the deployed schema does not match the build's, so a release that
needs a migration cannot quietly go live without it.

## 13. Handle stale content

Answers that are correct against Moodle but Moodle is out of date. The assistant cannot detect
this; only a person reading the source can.

1. Confirm it by following the answer's citation to the Moodle page.
2. Fix the content in Moodle. That is the only real fix.
3. Re-index that resource (procedure 1) rather than waiting for the nightly run.
4. If the page should not be answerable at all, hide or remove it in Moodle and reconcile
   (procedure 4).
5. Record the content owner for the course. Course material that nobody owns goes stale by
   default, and the assistant makes that more visible rather than worse.

## 14. Investigate an incorrect answer by correlation ID

Every answer card shows `Reference: <correlation ID>`. Ask the person for it; it is the thread
from the card back through the bot, the API, retrieval and the model.

1. In the administration area, find the answer outcome for that correlation ID: status, course
   IDs, source and citation counts, model, duration (docs/admin.md).
2. In Application Insights, the same ID appears on every log record and span for that question:

```kusto
union traces, requests, dependencies, exceptions
| where customDimensions.correlationId == "<id>"
| order by timestamp asc
```

3. Reproduce the retrieval without the model: `pnpm api retrieve --question "<question>"
--course-id <ids> --excerpts`. If the right passage is not retrieved, it is a retrieval or an
   indexing problem (procedures 1 to 3). If it is retrieved and the answer still missed it, it is
   a generation problem: add the case to `tests/evaluation/answer-cases.json` so it is measured
   from now on.
4. Remember what the logs do not hold: not the question text, not the answer, not any passage.
   That is deliberate (docs/security.md). The correlation ID, the counts and the course IDs are
   what you get; the question itself comes from the person.

## 15. Restore the previous application revision

docs/rollback.md. Summary: `infrastructure/scripts/rollback.sh prod` moves the API, bot and jobs
back to the previous image, changing nothing else, then prove with `pnpm preflight` and a
question in Teams.

## 16. Remove the Teams app

docs/teams-deployment.md, "Removing the app": take the app out of the pilot group's permission
policy, then block or delete it in the Teams admin centre. Stopping the bot's container app
stops answers immediately if that is the urgent need. Neither removes indexed content.
