# Teams deployment

Getting the assistant in front of pilot users: build the package, upload it privately, and let
exactly the approved group install it. docs/teams-app.md describes the app itself and the cards;
this is the deployment procedure.

## What gets uploaded

A Teams app package: `manifest.json` plus two icons, zipped. `pnpm teams:package --env production`
builds it reproducibly into `apps/teams-app/build/ehub-assistant-production-<version>.zip`, and
`pnpm release:verify` records that file's SHA-256 in the release report so what was approved can
be identified later.

The manifest declares the **personal scope only**. There is no team, channel or group-chat
scope, so the assistant cannot be added to a channel or a group chat even by someone who wants
to. That is a pilot control, enforced by the package rather than by a policy anybody could
change (docs/production-deployment.md).

Before building, the manifest inputs must be set — `TEAMS_APP_ID`, `TEAMS_BOT_CLIENT_ID`,
`TEAMS_DEVELOPER_NAME`, `TEAMS_WEBSITE_URL`, `TEAMS_PRIVACY_URL`, `TEAMS_TERMS_URL` — and
`TEAMS_APP_ID` is the manifest's own identifier, not the bot's client ID. Keep them in
`infrastructure/environments/release.env` (no secrets in that file).

```bash
pnpm teams:validate --env production   # schema and cross-field checks, no package written
pnpm teams:package --env production
```

Validation warns while the placeholder icons are still in use. That warning is not fatal, but
replace them before anyone outside the pilot sees the app: `apps/teams-app/manifest/color.png`
(192×192) and `outline.png` (32×32, transparent, single colour).

## Sign-in

The bot uses Entra ID single sign-on: Teams supplies a token for the signed-in user, the bot
exchanges it for a token for the answer API, and the API decides what that person may read from
their Moodle enrolments. Nobody types a password into the bot, and the bot never sees one.

The three settings that have to agree are `TEAMS_SSO_RESOURCE`, `ENTRA_API_APP_ID_URI` and
`ENTRA_ALLOWED_CLIENT_APP_IDS`; `pnpm preflight` checks them, because a mismatch produces a
sign-in failure that looks like a Teams problem and is not (docs/entra-sso.md).

The bot's Entra SSO connection on the Azure Bot resource is configured by
`infrastructure/scripts/configure-bot-sso.sh`, named by `TEAMS_SSO_CONNECTION_NAME`.

## Uploading privately

In the Teams admin centre, as a Teams administrator:

1. **Teams apps → Manage apps → Upload new app**, and choose the package. This is a custom app
   in your own tenant; it is not submitted to the Teams store and Microsoft does not review it.
2. Confirm the app is listed with the version from the manifest, and that its publisher is your
   organisation.
3. **Permission policies:** create a policy that allows this custom app, and assign the policy to
   the approved pilot security group only. Everyone else keeps the default policy, which does not
   allow it.
4. **Setup policies:** optionally pin the app for the pilot group, so they do not have to search
   for it.

Policy assignment can take a few hours to reach every client. A pilot user who cannot see the app
yet is usually waiting for that, not misconfigured.

_Proof:_ a pilot user finds the app, installs it, asks a question answerable from a selected
course, gets an answer with numbered sources, and the "Open in E-Hub" links open the right Moodle
activities. A non-pilot user cannot find the app at all.

## Updating the app

Raise the version in `apps/teams-app/package.json`, rebuild the package, and upload it over the
existing app (**Manage apps → the app → Update**). Teams distributes the new manifest to
installed users; they do not reinstall.

A manifest change that adds a permission or a scope makes users re-consent, so treat it as a
change with its own approval (docs/change-management.md). A change to the bot's code or the API
does not touch the manifest at all and needs no upload.

## Removing the app

docs/rollback.md covers rolling back a release. To withdraw the assistant from Teams:

1. **Permission policies:** remove the app from the pilot group's policy. New installs stop
   immediately; existing installs lose access as the policy propagates.
2. **Manage apps:** block the app. Blocked apps disappear from everyone's Teams.
3. To remove it completely, delete the uploaded app. Conversation history in Teams stays with the
   users; it is their chat data, not the app's.
4. Stopping the bot's container app also ends the service without touching Teams at all, which
   is the fastest way to stop answers if something is wrong (docs/incident-response.md).

Removing the app does not delete indexed content. To remove that as well, empty the course
selection and reconcile, or delete the search index (docs/backup-and-recovery.md).

## What staff can and cannot do in the app

- They ask questions in a one-to-one chat and get an answer with numbered citations.
- They can give a thumbs-up or thumbs-down on an answer, which is recorded without the question
  text (docs/admin.md).
- They cannot upload files, and the bot ignores attachments: there is no document-upload path in
  the pilot, by design.
- They cannot widen what they can read. Access comes from their Moodle enrolments, re-checked
  against Moodle rather than trusted from the client (docs/authorization.md).
