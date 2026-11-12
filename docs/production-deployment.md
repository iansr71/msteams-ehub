# Production deployment

How the E-Hub Teams Knowledge Assistant goes into production, as a checklist to work through
once, in order. It assumes the Azure infrastructure described in docs/infrastructure.md and the
pilot scope below.

Nothing here asks for a secret to be committed, pasted into a chat, or stored outside Key Vault.
The Moodle token and the bot client secret go into Key Vault directly; the deployed services
read them through Container Apps secret references resolved with their own managed identity, so
no human and no file in this repository ever holds them.

## Pilot controls

The first release is a controlled pilot, not a general rollout. These are the controls, and
`pnpm preflight` fails the deployment if any of the enforceable ones is wrong.

| Control                              | How it is enforced                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved pilot group only            | The Teams app is uploaded as a private app and assigned to one Entra security group (docs/teams-deployment.md). Entra group membership is the gate; the application does not keep its own user list. |
| Selected Moodle courses only         | `SYNC_COURSE_IDS` lists the approved course IDs. `SYNC_ALL_COURSES` must stay off: the preflight fails if it is on, and fails if no course is selected.                                              |
| Limited administration group         | The administration area is off unless `ADMIN_UI_ENABLED=true`, and then only app-role holders get in (docs/admin.md). Keep the role assigned to one or two people during the pilot.                  |
| Explicit feature flags               | Everything optional is off by default: the administration area, hidden-content indexing (`SYNC_INCLUDE_HIDDEN`), semantic ranking. Turn one on deliberately, one at a time.                          |
| Mock identity disabled in production | `API_DEV_MOCK_IDENTITY` and `TEAMS_DEV_MOCK_IDENTITY` are refused outside development; with either on, `pnpm api serve` refuses to start and the preflight fails.                                    |
| No channel or group-chat use         | The manifest lists the personal scope only, so the assistant cannot be added to a channel or a group chat (docs/teams-deployment.md).                                                                |
| No uploads                           | Staff cannot attach files; the bot answers text questions only. There is nothing to enable here, and nothing to turn off.                                                                            |

A pilot also needs a documented way out: see docs/rollback.md before starting, not after.

## Where each setting lives

| Kind                                 | Lives in                                                                                                              | Checked by                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Infrastructure parameters (`EHUB_*`) | `infrastructure/environments/prod.env`, not committed                                                                 | `infrastructure/scripts/validate.sh`          |
| Application settings, no secrets     | the container apps' environment, set by Bicep; a copy for release checks in `infrastructure/environments/release.env` | `pnpm release:verify -- --env-file …`         |
| Secrets                              | Key Vault only                                                                                                        | `pnpm preflight`, in the deployed environment |

## The checklist

Work through it in order. Each step says what proves it worked. Do not treat a step as done
because it looked right; the proof is the point.

### Moodle

1. **Create the Moodle service account.** A dedicated account, not a person's. No email
   notifications, no course editing rights. docs/moodle-production-setup.md, step 1.
   _Proof:_ the account exists and is confirmed, and nobody else knows its password.
2. **Grant the minimum web-service permissions.** A role with exactly the six functions the
   assistant calls, and read-only capabilities. docs/moodle-production-setup.md, step 2.
   _Proof:_ `pnpm indexer moodle:ping` lists exactly those six functions and no others.
3. **Set the token's expiry.** Issue the token with a deliberate expiry date rather than "never".
   Record the date in `MOODLE_TOKEN_EXPIRES_ON`.
   _Proof:_ `pnpm preflight` reports no token-expiry finding, and the date is in the environment
   file and in the rotation calendar entry (docs/token-rotation.md).
4. **Write the rotation procedure into the calendar.** A reminder 30 days before expiry, owned by
   a person, not by this document. docs/token-rotation.md.
   _Proof:_ the reminder exists and names the runbook step.
5. **Decide on outbound IP restriction.** Optional. With `EHUB_ENABLE_VNET=true` the apps egress
   through one NAT gateway address, which Moodle's firewall can allow.
   _Proof:_ if used, the gateway's address is in Moodle's allowlist and `pnpm diagnose` still
   reaches Moodle from the deployed app.

### Entra ID

6. **Register the applications.** Two registrations: the answer API and the bot. They are
   separate; sharing one breaks the audience checks. docs/entra-sso.md.
   _Proof:_ both appear in Entra, and `pnpm preflight` reports no `entra.separateRegistrations`
   finding.
7. **Configure tenant and audience.** `ENTRA_ALLOWED_TENANT_IDS` is the staff tenant.
   `ENTRA_API_APP_ID_URI` is the API's application ID URI, and `TEAMS_SSO_RESOURCE` is that URI
   (optionally with the scope appended).
   _Proof:_ no `entra.ssoResource` or `entra.allowedTenant` finding from the preflight. These two
   mistakes pass every other check and then fail at sign-in, in front of staff.
8. **Expose the API scope and grant consent.** `access_as_user` on the API registration, with the
   bot's client ID pre-authorised, and admin consent granted for the tenant so staff see no
   consent prompt. docs/entra-sso.md.
   _Proof:_ a pilot user signs in without a consent dialogue (step 19's proof covers this).
9. **Create the application roles.** The administration roles in docs/admin.md, assigned to the
   limited administration group only.
   _Proof:_ a role holder reaches the administration page and a non-holder gets 403.

### Azure

10. **Deploy the Azure resources.** Two stages, as docs/infrastructure.md describes.
    `infrastructure/scripts/deploy.sh prod --stage foundation` deploys monitoring, Key Vault,
    Azure AI Search, storage, the registry, the three identities, the roles, the network and the
    Container Apps environment. You then add the secrets (step 11), and
    `deploy.sh prod --stage apps` builds the image in the registry, checks that the secrets are
    there, and deploys the API, the bot, the jobs, the Azure Bot registration and the
    availability tests.
    _Proof:_ both deployments (`ehub-prod-foundation`, `ehub-prod-apps`) succeeded, and
    `infrastructure/scripts/what-if.sh prod` afterwards reports no pending change.
11. **Create the Key Vault secrets.** `moodle-token`, `teams-bot-client-secret` and
    `appinsights-connection-string`, set directly in the vault between the two stages. Never from
    a file in the repository, and never echoed into a terminal that is being recorded.
    _Proof:_ the deploy script's secret check passes, and the services start.
12. **Verify managed identity and RBAC.** Three user-assigned identities (API, bot, jobs) with
    the roles in docs/infrastructure.md. Azure AI Search has key authentication disabled, so the
    identity is the only way in.
    _Proof:_ `pnpm preflight` in the deployed environment reports `managed_identity: pass`, and
    `search`, `embedding` and `chat` as up.
13. **Create the search index.** `pnpm indexer search:create-index`, then
    `pnpm indexer search:validate-index`.
    _Proof:_ validation reports the deployed schema matching this build's.

### Content and quality

14. **Sync a test course first.** One approved course: `pnpm indexer sync:course --course-id <id>`.
    _Proof:_ the report shows resources indexed and none failed, and
    `pnpm api retrieve --question "<something in that course>"` returns chunks from it.
15. **Run the retrieval evaluation.** `pnpm evaluation:retrieval` against the deployment, with
    real staff questions in `tests/evaluation/retrieval-cases.json`.
    _Proof:_ the run exits 0, and hit@3 is good enough for the questions you care about.
16. **Run the answer evaluation.** `pnpm evaluation:answers`, with real cases in
    `tests/evaluation/answer-cases.json`.
    _Proof:_ no critical or grounding failures (docs/acceptance.md explains the severities).
17. **Run the security tests.** `pnpm test:security` on the release commit.
    _Proof:_ every control passes, and the secret scan is clean.

### Teams

18. **Validate and build the Teams package.** `pnpm release:verify -- --env-file
infrastructure/environments/release.env`, then `pnpm teams:package --env production`.
    _Proof:_ the release report says ready, and the package's checksum is recorded in it.
19. **Upload the app privately.** Teams admin centre, as a custom app, not published to the
    store. docs/teams-deployment.md.
    _Proof:_ the app appears in the tenant's app catalogue with the expected version.
20. **Assign the pilot users.** Permission policy scoped to the approved security group.
    _Proof:_ a pilot user can install it and a non-pilot user cannot see it. A pilot user asks a
    question, gets an answer with citations, and the citation links open the right Moodle pages.

### Operations

21. **Verify monitoring and alerts.** The availability tests and their alert rules are deployed
    with the infrastructure; the metric-based rules in docs/observability.md are not — create the
    ones you want and confirm each fires.
    _Proof:_ an alert arrives at the ops address for a deliberately failed test, and
    `pnpm diagnose` shows telemetry configured.
22. **Verify the backups.** docs/backup-and-recovery.md.
    _Proof:_ a file-share snapshot exists and a test restore of the sync state worked.
23. **Verify the rollback.** docs/rollback.md, on the real environment, before go-live.
    _Proof:_ `infrastructure/scripts/rollback.sh prod` moved the apps to the previous image and a
    question was still answered afterwards; then the intended image was redeployed.
24. **Record the production approval.** docs/acceptance-signoff.md, signed with the release
    report attached.
    _Proof:_ the signed sign-off names the commit, the release report and the rollback target.

## Release verification

`pnpm release:verify` runs every gate this repository can run: formatting, lint, types, unit,
integration, acceptance and security tests, both manifest validations, Bicep validation where the
CLI is installed, the secret scan, the release configuration check and the build. It writes
`reports/release/release-report.json` and `.md` with the version, commit, results, known
limitations, the manual checks that remain, the rollback commit, the Teams package location and
SHA-256 checksums of the deployment artefacts.

Supply the release environment file so the manifest and configuration checks can actually run:

```bash
cp infrastructure/environments/release.env.example infrastructure/environments/release.env
# fill in the identifiers; no secrets belong in this file
pnpm release:verify -- --env-file infrastructure/environments/release.env
```

A gate that could not run is reported as `blocked` and holds the release exactly as a failure
does. The report never says ready while anything is failed or blocked, and even when it says
ready it says plainly that this is not a statement that the deployment works — the live checks in
`pnpm preflight` and the manual checks in docs/acceptance-signoff.md are what establish that.

## Production startup validation

`pnpm preflight`, run in the deployed environment, is the gate between a deployment and staff
using it. It checks:

- every configuration feature production needs, by variable name;
- the secrets Key Vault supplies, as present and not placeholders;
- the settings that must agree with each other (audience, tenant, allowed client, link hosts);
- the pilot controls above;
- the Moodle token's recorded expiry;
- managed identity, by asking for a token;
- Moodle, Azure AI Search, the embedding deployment, the chat deployment and the state stores;
- the deployed index schema against this build's.

It fails closed: anything it could not check counts as a failure. `pnpm preflight --static`
checks configuration only and contacts nothing; `--scope release` is the subset that needs no
secret, which is what `pnpm release:verify` uses.

It does not check the Teams manifest variables, because the deployed containers never receive
them — they are packaging inputs, checked by `pnpm teams:validate` and by the release-scope check
before the package is built. A tool that failed inside the environment it was meant to check
would teach you to ignore it.

The answer API runs the same configuration checks itself at start-up in production (the
`apiService` scope: the settings that process must get right) and refuses to start if they fail,
rather than serving with sign-in bypassed.
