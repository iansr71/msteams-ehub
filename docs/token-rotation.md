# Moodle token rotation

The Moodle web-service token is the assistant's only credential for reading E-Hub, and it is a
bearer token: anyone holding it can read everything the service account can. Rotating it is
routine, and the procedure below causes no downtime if followed in order.

Do this once before go-live, so the first real rotation is not the first attempt.

## When

- **On expiry.** `MOODLE_TOKEN_EXPIRES_ON` records the date; `pnpm preflight` warns from 30 days
  out and fails once it has passed. Set a calendar reminder as well: a warning only helps if
  someone runs the preflight.
- **On suspicion.** Any sign the token has been seen by someone who should not have it — a
  pasted log, a screenshot, a shared file, a laptop that was lost. Rotate first, investigate
  after (docs/incident-response.md).
- **When the service account changes.** A new account means a new token.
- **After a Moodle upgrade that resets web-service configuration.** `pnpm indexer moodle:ping`
  tells you whether the token and the function list survived.

## Rotating without downtime

A Moodle account can hold more than one token for a service, so the new token works before the
old one is withdrawn. That is what makes this safe.

1. **Issue the new token.** In Moodle: Site administration → Server → Web services → Manage
   tokens → Create token, for the same service account and the same external service, with a new
   expiry date. Do not delete the old token yet.
2. **Put it in Key Vault.** Add a new version of the `moodle-token` secret, directly in the vault
   — portal or `az keyvault secret set` on a machine you trust. The value does not belong in a
   file, a ticket, a chat message or an email, and it never goes into this repository.
3. **Update the recorded expiry.** Set `MOODLE_TOKEN_EXPIRES_ON` to the new date in
   `infrastructure/environments/prod.env`.
4. **Restart the services so they read the new version.** Container Apps resolves secret
   references when a revision starts, so a running revision keeps the old value. Deploy with the
   same image tag (`infrastructure/scripts/deploy.sh prod --image-tag <current>`), which creates
   a new revision with the new secret, or restart the API and bot revisions in the portal. The
   scheduled jobs pick the new value up on their next run.
5. **Prove the new token works.** `pnpm preflight` in the deployed environment: Moodle up, no
   token-expiry finding. Then ask a question in Teams and confirm an answer with citations.
6. **Withdraw the old token.** Delete it in Moodle. Until this step, two working credentials
   exist, so do not leave it for later.
7. **Record it.** Date, who did it, new expiry, in the change log (docs/change-management.md).

## If the token has already expired

The sequence is the same, but there is downtime between step 1 and step 4, and it looks like
this while it lasts: questions whose answers are already indexed still work (retrieval does not
touch Moodle), course authorisation fails closed once the cached enrolments go stale, and every
sync job fails with `moodle_authentication`. Staff see "I could not confirm what you have access
to" rather than wrong answers.

Do not disable authorisation to get the assistant working again. Failing closed is the correct
behaviour, and turning it off would let anyone ask about any course.

## If the token may have leaked

1. Delete the old token in Moodle **first**. Availability is less important than an open door.
2. Then follow steps 1 to 5 above to restore service.
3. Check Moodle's web-service logs for calls that did not come from the assistant's address — if
   the token was IP-restricted, there should be none (docs/moodle-production-setup.md, step 4).
4. Consider whether the service account's permissions were wider than the six functions the
   assistant needs; narrow them while you are there.
5. Write it up (docs/incident-response.md). A leaked read-only token on an internal LMS is not a
   catastrophe, but it is a reportable event.

## What does not need rotating with it

- The **bot client secret** is separate, in Key Vault as `teams-bot-client-secret`, and expires
  on its own schedule in Entra. Rotate it the same way: new secret in Entra, new version in the
  vault, new revision, then remove the old one.
- The **search and model credentials** do not exist: those services are reached with managed
  identity, so there is nothing to rotate (docs/infrastructure.md).
- The **indexed content** is unaffected. A new token for the same account reads the same courses,
  and nothing needs re-indexing.
