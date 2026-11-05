# Microsoft Entra ID single sign-on

Phase 13 replaces the development mock identity with real users. Staff sign in once with their
Microsoft account through Teams. After that, every question reaches the answer API with an Entra
ID access token, and the API checks that token itself.

**Which courses** a signed-in user may ask about is decided from Moodle enrolments (phase 14,
[authorization.md](authorization.md)). Without Moodle course authorisation configured, a
signed-in user is authorised for no courses outside development, where `API_DEV_ENTRA_COURSE_IDS`
can grant a fixed set of test courses to every signed-in user.

## How it works

```text
Teams client ── SSO token for api://botid-<BOT_ID> ──▶ Bot Framework token service
                                                         │ on-behalf-of exchange (OAuth connection)
                                                         ▼
bot (apps/teams-app) ◀──── access token for api://<API_ID>/access_as_user
   │  Authorization: Bearer <token>   (forwarded unread)
   ▼
answer API (apps/api serve)
   validates: RS256 signature against Entra's published keys, issuer, audience, tenant,
   expiry and not-before, version 2.0, scope access_as_user, calling app, user token, user object ID
```

1. The user asks a question. The bot asks the Bot Framework token service for a token on the
   OAuth connection (`TEAMS_SSO_CONNECTION_NAME`).
2. If there is no token yet, the bot starts sign-in. Teams first tries a silent token exchange.
   If consent is needed, it shows a sign-in card. **The question is held for up to 10 minutes,
   per conversation, in memory.** When Teams reports that sign-in completed, the bot answers
   it. If sign-in fails, the user sees "Sign-in did not work" with an "Ask again" button.
3. The bot sends the token to the API as `Authorization: Bearer`. The bot never decodes the
   token, logs it or uses it to identify anyone. Teams message fields (`from.id`,
   `aadObjectId`, display names) are never treated as identity.
4. The API validates the token (`apps/api/src/auth/entraTokenValidator.ts`). Only then does it
   use the token's object ID (`oid`) as the user ID for logs, rate limits and feedback.

Feedback buttons use an existing token but never start a sign-in. If there is no token, the
user is asked to sign in by asking a question.

### What the API rejects

| Result | When                                                                                                                                                                                      | Response                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 401    | Missing or malformed token; not RS256 (including `alg: none`); bad signature; unknown key; expired or not yet valid; not a v2.0 token; wrong issuer or audience; no `oid`, `tid` or `sub` | `WWW-Authenticate: Bearer` (`error="invalid_token"` when a token was sent) |
| 403    | Tenant not allowed; calling app (`azp`) not allowed; scope missing `access_as_user`; an app-only token (`idtyp` is not `user`)                                                            | `insufficient_scope` challenge for the scope case                          |
| 403    | Valid user with no authorised courses                                                                                                                                                     | `no_authorized_courses`                                                    |
| 503    | Entra's signing keys could not be fetched                                                                                                                                                 | `authentication_unavailable` (fail closed)                                 |
| 401    | Both a token and the mock header were sent (development)                                                                                                                                  | refused, never guessed                                                     |

Logs carry the rejection reason code only, never the token or its claims.

## Setup

These steps are done in the Azure portal by a Global Administrator, or by an Application
Administrator plus someone who can grant admin consent. Replace `<BOT_ID>`, `<API_ID>` and
`<TENANT_ID>` with your values. Nothing here is a secret except the bot's client secret, which
lives only in the Azure Bot resource (and, for local development, in `.env`).

### 1. API app registration (the resource)

Microsoft Entra ID → App registrations → New registration.

- Name: `E-Hub Answer API (<environment>)`. Supported account types: **single tenant**.
  No redirect URI.
- **Expose an API**:
  - Application ID URI: `api://<API_ID>` (the default).
  - Add a scope: `access_as_user`, _Admins and users_ can consent. Admin consent display
    name: "Ask the E-Hub Knowledge Assistant".
- **Manifest**: set `"requestedAccessTokenVersion": 2` (Microsoft Graph manifest:
  `api.requestedAccessTokenVersion`). The API accepts only v2.0 tokens.
- **Token configuration** → optional claims for the access token: `email`, `upn`, `acct`,
  `idtyp`. These are for logging context and guest detection. The API does not need them to
  identify users: it uses `oid`.

### 2. Bot app registration (the client)

This is the registration already used as `TEAMS_BOT_CLIENT_ID` (phase 12).

- **Expose an API**:
  - Application ID URI: `api://botid-<BOT_ID>`.
  - Add a scope `access_as_user` (admins and users).
  - Add **authorised client applications** for that scope:
    - `1fec8e78-bce4-4aaf-ab1b-5451cc387264`: Teams desktop and mobile.
    - `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`: Teams web.
- **Authentication** → add a Web redirect URI:
  `https://token.botframework.com/.auth/web/redirect`.
- **API permissions**:
  - Add _My APIs → E-Hub Answer API → access_as_user_ (delegated).
  - Keep Microsoft Graph `openid` and `profile`.
  - **Grant admin consent** for the tenant, so staff are not asked one by one.
- **Certificates & secrets**: create a client secret for the OAuth connection (step 3). Record
  its expiry date: when it expires, sign-in stops working for everyone.

### 3. OAuth connection on the Azure Bot resource

Azure Bot → Configuration → **Add OAuth Connection Settings**:

| Setting            | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| Name               | e.g. `ehub-sso`; this goes in `TEAMS_SSO_CONNECTION_NAME` |
| Service provider   | Azure Active Directory v2                                 |
| Client ID / secret | the bot registration's ID and the secret from step 2      |
| Token Exchange URL | `api://botid-<BOT_ID>`                                    |
| Tenant ID          | `<TENANT_ID>`                                             |
| Scopes             | `api://<API_ID>/access_as_user`                           |

Use **Test connection** on the saved connection. It should sign you in and show a token. Paste
that token into a JWT decoder you trust, offline, and check that `aud` is `<API_ID>`, `azp` is
`<BOT_ID>`, `scp` contains `access_as_user` and `ver` is `2.0`.

### 4. Teams app manifest

`teams:validate` now requires, and the template provides:

```json
"validDomains": ["token.botframework.com"],
"webApplicationInfo": { "id": "<BOT_ID>", "resource": "api://botid-<BOT_ID>" }
```

`TEAMS_SSO_RESOURCE` overrides the resource if your bot registration uses a different
Application ID URI. A mismatch fails sign-in for every user, so validation warns when the
resource does not end in `botid-<BOT_ID>`. Increase the app version and upload the new package.

### 5. Settings

Answer API:

| Variable                        | Value                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `AZURE_TENANT_ID`               | `<TENANT_ID>`                                                                  |
| `ENTRA_API_CLIENT_ID`           | `<API_ID>`; tokens must have this audience                                     |
| `ENTRA_API_APP_ID_URI`          | optional, also accepted as audience (v2 tokens normally carry the GUID)        |
| `ENTRA_ALLOWED_CLIENT_APP_IDS`  | `<BOT_ID>`; comma-separated if more apps may call the API                      |
| `ENTRA_ALLOWED_TENANT_IDS`      | default `AZURE_TENANT_ID`; must include it                                     |
| `ENTRA_API_SCOPE`               | default `access_as_user`                                                       |
| `ENTRA_CLOCK_TOLERANCE_SECONDS` | default 120                                                                    |
| `ENTRA_AUTHORITY_HOST`          | default `https://login.microsoftonline.com` (change only for sovereign clouds) |
| `API_DEV_ENTRA_COURSE_IDS`      | development only: test courses for every signed-in user without `MOODLE_TOKEN` |

Bot: `TEAMS_SSO_CONNECTION_NAME=ehub-sso`, together with `TEAMS_BOT_CLIENT_ID` (the bot
refuses to start with a connection name but no bot registration).

`pnpm api health` reports whether the `entraAuth` group is complete, without printing values.
`/health` on both services shows the identity mode: `entra`, `entra+dev-mock`, `entra-sso`,
`dev-mock` or `none`.

## Development switches

- `API_DEV_MOCK_IDENTITY`, `TEAMS_DEV_MOCK_IDENTITY` and `TEAMS_DEV_ALLOW_UNAUTHENTICATED`
  work only with `NODE_ENV=development`. In any other environment they are **switched off
  automatically**, and a warning is logged. This means a stray variable cannot open a hole.
- With SSO configured, the bot ignores its mock identity (and logs a warning). The API can
  accept both in development (`entra+dev-mock`). It refuses a request that carries both.

## Guest users

About 90 branch staff use Teams as guests on personal email addresses. For a guest:

- The token is issued by **Skin Renewal's tenant** (the resource tenant). So `tid` is our
  tenant, and the allowlist does not need guests' home tenants.
- `oid` is the guest's object ID in our tenant.
- `acct` is `1` (recorded as `accountType: guest`).
- `idp` names the home identity provider (for example `live.com`, or `mail` for one-time
  passcodes).

**Not verified yet:**

- whether guests on personal Microsoft accounts and one-time-passcode guests can complete
  Teams SSO for a custom org app;
- whether Teams lets guests install it at all.

Test this with one real guest account before rollout. Users are mapped to Moodle accounts by
email or an explicit mapping (phase 14, [authorization.md](authorization.md)).
The `email` and `upn` claims of guests differ from members' (a guest's `upn` looks like
`name_gmail.com#EXT#@tenant.onmicrosoft.com`), so that mapping must not assume `upn` is an
email address.

## Verified and unverified

Verified by tests in this repository (no network):

- Each rejection in the table above, with locally signed tokens. This covers: expired, wrong
  issuer, wrong audience, wrong tenant, missing object ID, a forged payload with the original
  signature, unsigned (`alg: none`), unknown key, HS256, app-only and wrong client.
- The bot forwards the token unread, holds and resumes the question, and fails closed when the
  token service errors.
- Mock identities are switched off outside development.

Assumed from Microsoft documentation, **not yet tested in the Skin Renewal tenant**:

- The OAuth connection's on-behalf-of exchange from `api://botid-<BOT_ID>` to the custom API
  scope. Microsoft's examples mostly use Microsoft Graph scopes. Step 3's "Test connection"
  check is the first thing to run.
- That the silent exchange succeeds on Teams desktop, web and mobile once admin consent is
  granted, and that a sign-in card appears only before consent.
- Guest behaviour (above).

## Limitations

- Held questions live in one process's memory. They are lost on restart, and running several
  bot instances needs shared state (phase 19).
- No sign-out command. Tokens expire on their own (about an hour). Revoking a user in Entra
  takes effect when the current token expires, not immediately.
- The API trusts Entra's published signing keys over HTTPS. If Entra's keys cannot be fetched,
  requests fail with 503 rather than being let through.
