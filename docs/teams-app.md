# Teams personal app

Phase 12 adds the E-Hub Knowledge Assistant as a Microsoft Teams **personal app**: a one-to-one
chat with a bot, on Teams desktop and web (and mobile, which renders the same cards). No
channels, no group chats, no notifications, no grades or assignments.

**Sign-in:** users sign in with Microsoft Entra ID single sign-on (phase 13, see
[entra-sso.md](entra-sso.md)). **Production is still blocked:** until enrolment-based course
access (phase 14) limits each user to their own courses, the bot and the answer API refuse to
start with `NODE_ENV=production`, and `teams:package` refuses to build a production package.

## How it fits together

```text
Teams client ──Bot Framework──▶ bot (apps/teams-app, port 3978)
                                  │  POST /v1/answers   x-correlation-id, Authorization: Bearer <Entra token>
                                  │                     (development: x-ehub-mock-identity instead)
                                  ▼
                                answer API (apps/api `serve`, port 3000)
                                  │  retrieval + grounded answer + citation validation (phases 7-10)
                                  ▼
                                Azure AI Search, Azure OpenAI
```

- The bot holds **no Moodle or Azure service credentials**. It knows the answer API's URL and,
  to talk to Teams, its own bot registration (client ID, and locally a client secret).
- The answer API is new in this phase (`apps/api/src/http/`): `GET /health`,
  `POST /v1/answers`, `POST /v1/feedback`. The request and response contract is shared and
  validated on both sides (`packages/shared/src/answers/contract.ts`).
- Teams-specific code is confined to `apps/teams-app/src/teams/` (SDK adapter and HTTP
  transport). The conversation (`conversation/`), the API client (`api/`) and the card
  renderers (`cards/`) have no Teams SDK imports and are tested without Teams.
- SDK: the Microsoft Teams SDK for TypeScript, `@microsoft/teams.apps` 2.1.1, which Microsoft
  describes as the main toolkit for Teams agents (the Microsoft 365 Agents SDK is the
  multi-channel alternative). The card types are checked at compile time against the SDK's
  Adaptive Card types.

## Conversation

1. **Install or "hi"/"help"**: a welcome card with three suggested questions (buttons that post
   the question as the user).
2. **A question**: the bot shows "typing", calls the API, and replies with an answer card.
   Teams retries an activity whose HTTP response takes more than 15 seconds, and answers can
   take longer, so the bot acknowledges at once and answers in the background. Redelivered
   activities (same ID) are ignored.
3. **Answer card**: the direct answer; supporting points (each with its citation numbers, shown
   only when they add to the answer); numbered sources with course › section, page or slide, a
   short excerpt and **Open in E-Hub**; and **Useful / Not useful** buttons.
4. **Insufficient evidence**: a clearly marked "Not enough information" card that says the bot
   has not guessed, with tips. An answer without citations is always shown this way, even if
   the API ever sent one.
5. **Errors**: timeout, API unreachable, malformed response, busy, rate limited, no access,
   sign-in unavailable: each has its own card with a reference ID, and "Ask again" where a retry
   can help.
6. **Group chats and channels**: the manifest only allows personal scope; if a message arrives
   from elsewhere anyway, the bot replies that it works in personal chat only and does not call
   the API.

Each turn gets a new correlation ID. It is sent to the API as `x-correlation-id`, used as the
answer's ID, stamped on every log line in both services, and shown on the card as "Reference",
so a staff member's screenshot leads straight to the logs.

### Feedback

Buttons are Adaptive Card Universal Actions (`Action.Execute`, with an `Action.Submit` fallback
for older clients). The bot answers the button with a short confirmation and forwards
`{answerId, rating}` to `POST /v1/feedback`. The API logs one structured event per rating with a
pseudonymous user key (a hash), never the question or answer. Storage and reporting arrive with
the administration UI (phase 15).

## Identity

- Teams message fields (`from.id`, `aadObjectId`, names) are **not** used as identity. The
  bot's inbound requests are authenticated by the SDK (Bot Framework token) when bot
  credentials are configured, which proves the request came from Teams, not who the user is to
  our API.
- **Single sign-on** (phase 13): with `TEAMS_SSO_CONNECTION_NAME` set, the bot gets the user's
  Entra ID access token through the Azure Bot OAuth connection and forwards it unread as
  `Authorization: Bearer`; the API validates it. Questions asked before sign-in completes are
  held and answered afterwards. Setup and behaviour: [entra-sso.md](entra-sso.md).
- For local development, `TEAMS_DEV_MOCK_IDENTITY=true` (bot) and `API_DEV_MOCK_IDENTITY=true`
  (API) enable an explicit mock user, `dev-mock-user` by default (user IDs must start with
  `dev-mock-`). The API, not the caller, decides the mock user's courses
  (`API_DEV_MOCK_COURSE_IDS`). Every card shows a yellow "Development mode — mock identity"
  banner. When SSO is configured, the bot ignores its mock switch.
- The mock and unauthenticated switches work only with `NODE_ENV=development`; elsewhere they
  are switched off automatically with a logged warning, the classes that implement them refuse
  to be constructed, and both services refuse to start in production at all.
- With no identity configured, the bot answers "Sign-in is not available" and the API answers
  503 `authentication_not_configured`: fail closed.

## Rendering and safety

- Untrusted text (answers, claims, Moodle names, excerpts) is rendered only in Adaptive Card
  `TextRun`s, which do not interpret Markdown, so a Moodle document cannot create links or
  formatting. Control and bidirectional characters are removed, `{{DATE(...)}}` templates are
  defused, and every value is length-bounded.
- "Open in E-Hub" appears only for https links without credentials; the API already limits
  links to approved hosts, and `TEAMS_ALLOWED_LINK_HOSTS` adds a second check in the bot.
- **Card size.** Microsoft's guidance puts the bot message limit at about 40 KB (earlier
  documentation said 28 KB; larger messages are rejected with HTTP 413). Cards are kept under
  `TEAMS_CARD_MAX_BYTES` (default 24,000 bytes, at most 28,000): the renderer drops excerpts,
  then supporting points, then shows fewer sources and shorter text, and says when it has
  shortened anything. Tests render the largest response the contract allows at 8,000-28,000
  bytes.

## Manifest and package

```text
apps/teams-app/manifest/
  manifest.template.json        manifest v1.24, ${{VARIABLE}} placeholders
  environments/development.json name "E-Hub Assistant (Dev)", accent colour
  environments/production.json  name "E-Hub Assistant" (packaging blocked until phase 14)
  color.png, outline.png        PLACEHOLDER icons
```

Variables (environment or `.env`; not secrets, but environment-specific):

| Variable               | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `TEAMS_APP_ID`         | A GUID you generate once per environment (the app's identity in Teams)  |
| `TEAMS_BOT_CLIENT_ID`  | The bot's Microsoft Entra app registration (client) ID                  |
| `TEAMS_SSO_RESOURCE`   | Optional; `webApplicationInfo.resource`, default `api://botid-<bot ID>` |
| `TEAMS_DEVELOPER_NAME` | Shown in the app details, e.g. `Skin Renewal` (max 32 characters)       |
| `TEAMS_WEBSITE_URL`    | https                                                                   |
| `TEAMS_PRIVACY_URL`    | https; Skin Renewal's staff privacy notice                              |
| `TEAMS_TERMS_URL`      | https; terms of use / acceptable-use policy                             |

```bash
pnpm teams:validate                  # development; exit 1 on any problem
pnpm teams:validate --env production # reports that production is blocked until phase 14
pnpm teams:package                   # apps/teams-app/build/ehub-assistant-development-<version>.zip
```

`teams:validate` checks:

1. **Microsoft's JSON schema** for manifest v1.24 (bundled in `@microsoft/app-manifest`, so it
   works offline).
2. **This app's policy**: exactly one bot, personal scope everywhere, no files, no tabs other
   than the bot's chat and about tabs, no message extensions or connectors, no wildcard domains, no all-zero placeholder IDs, and
   single sign-on wired to the bot: `webApplicationInfo.id` is the bot ID, its resource is
   `TEAMS_SSO_RESOURCE` (warning if it does not end in `botid-<bot ID>`), and `validDomains`
   includes `token.botframework.com`.
3. **No secrets**: no secret variable's value, no credential-like property names, no URLs
   with token-like parameters.
4. **Icons** (below).

The version comes from `apps/teams-app/package.json`; Teams requires the version to increase
whenever an updated package is uploaded.

Manifest v1.24 is used because personal-scope apps do not need a newer version. (A Developer
Portal validation message reported on Microsoft Q&A requires v1.25 or later for apps with
**team** scope, which this app does not have.) Move to a newer version deliberately, after
checking the Developer Portal accepts it.

### Replacing the placeholder icons

The bundled icons are a generated purple square with a white "E" and must be replaced before a
wider rollout. Requirements (checked by `teams:validate`, which warns while the placeholders are
in use):

- `color.png`: 192 × 192 pixels, PNG, full colour, with the symbol well inside the edges
  (Teams rounds the corners; see Microsoft's app icon guidelines for the exact safe area). Use
  Skin Renewal-approved artwork.
- `outline.png`: 32 × 32 pixels, PNG, **white on a fully transparent background** (no other
  colours; any opacity of white is fine). Shown in the Teams app bar.

Regenerate the placeholders with `pnpm --filter @ehub/teams-app run manifest icons`.

## Running locally

### 1. Automated tests (no Teams, no tenant)

```bash
pnpm vitest run apps/teams-app apps/api/src/http
pnpm vitest run --project integration tests/integration/teams-end-to-end.test.ts
```

The end-to-end test runs the real bot and the real `pnpm api serve` as separate processes:
a Teams activity goes in, an Adaptive Card comes out, and one correlation ID links both logs.

### 2. Microsoft 365 Agents Playground (no tenant needed)

Agents Playground imitates the Teams client locally. It sends unsigned requests, so the bot must
explicitly allow them (development only).

```bash
# .env (development)
NODE_ENV=development
API_DEV_MOCK_IDENTITY=true
API_DEV_MOCK_COURSE_IDS=12            # courses the mock user may ask about
TEAMS_DEV_MOCK_IDENTITY=true
TEAMS_DEV_ALLOW_UNAUTHENTICATED=true
# …plus the Moodle, Azure AI Search, Azure OpenAI and AZURE_TENANT_ID settings from earlier phases

pnpm api serve                        # terminal 1: answer API on 127.0.0.1:3000
pnpm teams:dev                        # terminal 2: bot on port 3978

npm install -g @microsoft/m365agentsplayground
agentsplayground -e http://localhost:3978/api/messages -c msteams
# then open http://localhost:56150
```

### 3. Real Teams (approved test tenant or pilot users)

1. **Register the bot** in the Teams Developer Portal (Tools → Bot management → New bot) or as
   an Azure Bot resource with the Microsoft Teams channel. Use a **single-tenant** Entra app
   registration in the Skin Renewal tenant; create a client secret for local use. Put the
   client ID in `TEAMS_BOT_CLIENT_ID`, the secret in `TEAMS_BOT_CLIENT_SECRET` (`.env` only,
   never committed) and the tenant ID in `TEAMS_BOT_TENANT_ID`.
2. **Expose the bot** with a tunnel, e.g. Microsoft Dev Tunnels:
   `devtunnel host -p 3978 --allow-anonymous`. Set the bot's messaging endpoint to
   `https://<tunnel-host>/api/messages`. ("Anonymous" refers to the tunnel; the bot still
   validates the Bot Framework token on every request once credentials are set.)
3. **Turn off** `TEAMS_DEV_ALLOW_UNAUTHENTICATED`, keep the two mock identity switches, and run
   `pnpm api serve` and `pnpm teams:dev`.
4. **Build the package**: set the manifest variables, then `pnpm teams:validate` and
   `pnpm teams:package`.
5. **Upload it to an approved environment** (one of):
   - **Personal sideload, for IT only**: Teams → Apps → Manage your apps → Upload an app →
     Upload a custom app. Requires a Teams app setup policy that allows custom app upload for
     your account. Use this for your own testing.
   - **Org catalog, limited to a pilot group** (recommended): Teams admin center → Teams apps →
     Manage apps → Upload new app. Then use an app permission policy (or app centric management)
     so only the pilot users can install it, and leave it out of everyone else's setup policy.
     Remove or block it again after the pilot.

   Do not publish the development package to the whole organisation: it uses a mock identity,
   so everyone would see the mock user's courses.

6. Open the app in Teams and send "hi".

## Configuration

| Variable                               | Default                 | Notes                                                        |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `TEAMS_BOT_PORT`                       | 3978                    |                                                              |
| `TEAMS_BOT_CLIENT_ID`                  | none                    | Required unless unsigned requests are allowed                |
| `TEAMS_BOT_CLIENT_SECRET`              | none                    | Local development only; Azure uses Managed Identity          |
| `TEAMS_BOT_TENANT_ID`                  | none                    | Single-tenant bot registration                               |
| `TEAMS_API_BASE_URL`                   | `http://127.0.0.1:3000` | Must be https in production                                  |
| `TEAMS_API_TIMEOUT_MS`                 | 60000                   | Per question                                                 |
| `TEAMS_DEV_MOCK_IDENTITY`              | false                   | Development only                                             |
| `TEAMS_DEV_MOCK_USER_ID`               | `dev-mock-user`         | Must match `API_DEV_MOCK_USER_ID`                            |
| `TEAMS_DEV_ALLOW_UNAUTHENTICATED`      | false                   | Development only (Agents Playground)                         |
| `TEAMS_ALLOWED_LINK_HOSTS`             | any https host          | e.g. the E-Hub host name                                     |
| `TEAMS_MAX_CONCURRENT_QUESTIONS`       | 8                       | Further questions get a "busy" card                          |
| `TEAMS_CARD_MAX_BYTES`                 | 24000                   | 8000-28000                                                   |
| `API_HOST`                             | `127.0.0.1`             | Answer API interface                                         |
| `PORT`                                 | 3000                    | Answer API port                                              |
| `API_REQUEST_TIMEOUT_MS`               | 90000                   | Per answer, inside the API                                   |
| `API_DEV_MOCK_IDENTITY`                | false                   | Development only                                             |
| `API_DEV_MOCK_USER_ID`                 | `dev-mock-user`         |                                                              |
| `API_DEV_MOCK_COURSE_IDS`              | none                    | Required with the mock identity                              |
| `API_DEV_ENTRA_COURSE_IDS`             | none                    | Development only; courses for signed-in users until phase 14 |
| `ENTRA_*`, `TEAMS_SSO_CONNECTION_NAME` | none                    | Single sign-on; see [entra-sso.md](entra-sso.md)             |

The SDK also reads `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` and
`DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS` when options are not passed. The bot always passes
the unauthenticated option explicitly, so that variable has no effect; do not set the others.

`/health` on both services reports status, version and identity mode (`degraded` when no
identity is configured). It is unauthenticated and reveals no configuration values.

## Known limitations

- No enrolment-based course access until phase 14: signed-in users see no courses outside
  development.
- **Guest users.** Branch staff use Teams as guests on personal email addresses. Whether guests
  can install the app and complete SSO has not been verified in the tenant; see
  [entra-sso.md](entra-sso.md#guest-users).
- Feedback is logged, not stored or reported (phase 15). Any authenticated caller can rate any
  answer ID; ratings carry no content, so the risk is noise, not disclosure.
- The bot's in-memory state (duplicate detection, in-flight count) is per process; running
  several instances needs shared state (phase 19).
- Questions in flight when the bot stops are lost; the user sees no answer and can ask again.
- The answer API has no rate limiting yet (phase 17).
