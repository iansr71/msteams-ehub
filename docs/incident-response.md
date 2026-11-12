# Incident response

What to do when the assistant is broken, wrong, or possibly compromised. Written for one
administrator working alone, so every step is something one person can actually do.

The guiding rule: **it is always acceptable to stop the assistant.** Staff lose a convenience and
fall back to reading E-Hub directly, which is what they did before. It is never acceptable to
leave it answering when you suspect it is answering wrongly or to the wrong people.

## Severity, and what it means for you

| Severity     | What it looks like                                                                                                            | First move                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1 — unsafe   | Someone sees content they should not, a credential may have leaked, or answers are confidently wrong about clinical procedure | Stop the bot now, then investigate                 |
| 2 — broken   | Nobody gets answers, or sign-in fails for everyone                                                                            | Investigate; roll back if a release caused it      |
| 3 — degraded | Slow answers, one course missing, one person affected, syncs failing                                                          | Work through the runbook; no need to stop anything |
| 4 — cosmetic | A card renders oddly, a citation label is wrong                                                                               | Log it for the next release                        |

## Stop the assistant

```bash
az containerapp update --name <bot app> --resource-group <rg> --min-replicas 0 --max-replicas 0
```

Immediate: staff get no reply instead of a wrong one. Restore with `--min-replicas 1
--max-replicas 1`. docs/rollback.md has the alternatives and their trade-offs.

## The first five minutes

1. **Establish what is actually happening.** `pnpm preflight` in the deployed environment names
   the layer: configuration, identity, Moodle, Search, the model, the state store, or the index
   schema. Start there rather than from a guess.
2. **Ask for a reference.** Every answer card carries `Reference: <correlation ID>`. One ID turns
   a vague report into a traceable request (docs/operations-runbook.md, procedure 14).
3. **Check whether anything changed.** A deployment, a Moodle upgrade, an Entra change, a token
   expiry, an Azure incident. Most incidents have a change behind them, and the fix is usually to
   undo it.
4. **Decide severity** from the table above, and act on the first move for that row before
   diagnosing further.

## Playbooks

### Nobody gets an answer

`pnpm preflight` will usually name it:

- `moodle: fail` with `authentication` — the token expired or was revoked
  (docs/token-rotation.md). Authorisation fails closed, so staff are told access could not be
  confirmed rather than being given unrestricted answers.
- `search: fail` — the index is missing or the identity lost its role. `pnpm indexer
search:health`, then check the role assignments (docs/infrastructure.md).
- `chat: fail` or `embedding: fail` — the model deployment is gone, renamed, or out of quota.
  Azure OpenAI quota exhaustion looks like a model failure; check the deployment's metrics.
- `index schema: incompatible` — a release expects a schema the deployed index does not have.
  Roll back, or migrate (docs/operations-runbook.md, procedure 12).
- Everything passes and staff still get nothing — the bot is the problem, not the API. Check the
  bot's logs and its Entra SSO connection (docs/entra-sso.md).

### Sign-in fails for everyone

Almost always one of the three settings that must agree: `TEAMS_SSO_RESOURCE`,
`ENTRA_API_APP_ID_URI`, `ENTRA_ALLOWED_CLIENT_APP_IDS`. `pnpm preflight` reports a consistency
finding by name. Other causes: the bot client secret expired in Entra (rotate it, same procedure
as the Moodle token), or admin consent was revoked for the API's scope.

### One person cannot get answers

Not an incident — docs/support-troubleshooting.md. Usually identity mapping or enrolments.

### Someone saw content they should not have

Severity 1. Stop the bot first.

1. Get the correlation ID and the course the content came from.
2. Confirm what that person is actually enrolled in: `pnpm authorization courses
--entra-object-id <guid>` reads Moodle directly, bypassing the cache.
3. If Moodle says they are enrolled, this is a Moodle enrolment problem, not an assistant
   problem: the assistant showed them what their enrolment allows. Fix the enrolment, then
   `pnpm authorization invalidate --entra-object-id <guid>`.
4. If Moodle says they are not enrolled, this is a real authorisation defect. Keep the bot
   stopped. Collect the correlation ID, the administration area's record of that answer, and the
   course IDs on the request, and write the case up as a failing acceptance test before changing
   any code — suite 13 exists for exactly this (docs/acceptance.md).
5. Check whether an explicit identity mapping was approved for that person
   (`pnpm identity resolve`), since an incorrect mapping grants everything the mapped Moodle
   account can read.

### A credential may have leaked

Severity 1, and the order matters: revoke first, restore second.

- **Moodle token:** delete it in Moodle immediately, then rotate (docs/token-rotation.md). The
  assistant is down in between; accept that.
- **Bot client secret:** remove it in Entra, add a new one, update the Key Vault secret, redeploy.
- **Anything pasted into a chat, ticket or screenshot** counts as leaked. Rotate it; do not
  reason about whether it was really exposed.

Then: how did it get out? `pnpm secrets:scan` over the repository, and check whether any log,
report or support reply carried a value. The redaction rules exist to make that unlikely
(docs/security.md), so a leak through them is itself worth understanding.

### Answers are confidently wrong

Severity 1 if the subject is clinical procedure, 3 otherwise.

1. Follow the citation. If the Moodle page says what the answer said, the content is wrong, not
   the assistant (docs/operations-runbook.md, procedure 13) — and that is worth telling the course
   owner urgently.
2. If the answer went beyond its sources, that is a grounding defect. Capture the correlation ID,
   reproduce the retrieval with `pnpm api retrieve --excerpts`, and add the case to
   `tests/evaluation/answer-cases.json`.
3. Remember what grounding does and does not prove: a claim that cites a real passage and reuses
   its words can still misread it, and no automated check catches that (docs/acceptance.md). If
   this is happening repeatedly in one subject area, narrow the course selection until it is
   understood.

### The sync keeps failing

Severity 3. `pnpm diagnose` shows the lag and the failed count. Then procedures 3 and 5 in the
runbook. A single quarantined resource (an encrypted PDF, a corrupt file) is normal and does not
need an incident; the index keeps serving everything else.

## Closing an incident

1. Restore service, and prove it: `pnpm preflight`, then a real question in Teams.
2. Write it down while it is fresh: what happened, when, who was affected, what you did, what the
   cause was, and what would have caught it. A page is enough.
3. Turn the cause into a check if it can be one — a test, a preflight finding, a runbook step, an
   alert. An incident that leaves nothing behind will happen again.
4. If staff were affected, tell them plainly what went wrong and what changed. Trust in an
   assistant that answers from policy documents is the whole asset.
