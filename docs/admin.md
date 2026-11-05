# Administration area

Phase 15 adds a small administration website to the answer API: `https://<api>/admin`. It
shows sync state, course and resource status, failures, identity mappings, configuration and
the audit trail. It also runs a few manual actions. Everything it shows or does is checked on
the server against the signed-in user's **Entra app roles**. Hiding a button on the page is a
convenience, never the control.

It is off unless `ADMIN_UI_ENABLED=true`.

## Roles

App roles defined on the **API app registration** (docs/entra-sso.md, step 1) and assigned to
users under _Enterprise applications → E-Hub Answer API → Users and groups_. Assigning
individual users works without Entra ID P1; assigning groups needs P1.

| Role                            | Pages                                                      | Actions                                                       |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `EHub.User`                     | none (uses the assistant only)                             | none                                                          |
| `EHub.Auditor`                  | all pages, including identity mappings and the audit trail | none                                                          |
| `EHub.ContentAdministrator`     | dashboard, courses, sync jobs, failures, configuration     | incremental sync, course re-index, resource retry             |
| `EHub.ApplicationAdministrator` | all pages                                                  | all, including identity overrides and enrolment cache refresh |

Role names must match exactly. Roles from other apps in the same token are ignored. The
matrix lives in `apps/api/src/admin/roles.ts`, and `adminRoles.test.ts` checks every endpoint
against every role.

`EHub.User` is defined for completeness. **The answer API does not require it yet.** Every
signed-in user of the tenant can ask questions, limited to their Moodle courses (phase 14). To
require it, enable _Assignment required_ on the API's enterprise application. Entra then
issues tokens only to assigned users. Decide this before rollout, because each of the ~120
staff would need an assignment.

## Pages

| Page              | Shows                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard         | last successful sync; running syncs (flagged _possibly stale_ when older than the lease time, e.g. after a crash); included courses; indexed, skipped (excluded), failed and removed resources; insufficient-evidence answers in 7 days; feedback in 30 days |
| Courses           | Moodle course ID, name (from Moodle), included or not, last indexed, resource and failure counts; **Re-index** for included courses                                                                                                                          |
| Sync jobs         | job ID, type, status, start and finish, counts and stop category, correlation ID                                                                                                                                                                             |
| Failures          | course, resource, stage (download, extraction, chunking, embedding, indexing), sanitised category, retry count; **Retry**                                                                                                                                    |
| Identity mappings | explicit mappings (Entra object ID, Moodle user ID, method, status, approver); recent denials with their reason; **Approve an override**, **Remove**, **Refresh access**                                                                                     |
| Configuration     | an allow-list of non-secret settings: included courses, retrieval top K and thresholds, sync settings, feature flags, log level, retention. Read-only                                                                                                        |
| Audit trail       | every administrative mutation of the last 30 days                                                                                                                                                                                                            |

Nothing shows document text, Moodle error messages or secrets. Resource IDs include file names
(e.g. `702:file:/Consultation checklist.pdf`), which are metadata, not content.

## Actions

| Action                    | Who                            | Confirmation   | Notes                                                                                                                                     |
| ------------------------- | ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Incremental sync          | Content and Application admins | no             | Same job as `pnpm indexer sync:incremental`                                                                                               |
| Course re-index           | Content and Application admins | **yes**        | `sync:course --force`: every resource downloaded, extracted and embedded again (uses embedding quota). Only courses in the sync selection |
| Resource retry            | Content and Application admins | no             | Only resources the state store lists as failed, dead-lettered or quarantined, in included courses                                         |
| Enrolment cache refresh   | Application admins             | for "everyone" | Clears cached course access for one user or for everyone; the next question re-reads Moodle                                               |
| Approve identity override | Application admins             | **yes**        | Moodle must confirm the account exists and is active. Replaces automatic matching for that user. Invalidates their cached access          |
| Remove identity mapping   | Application admins             | **yes**        | The user falls back to automatic matching                                                                                                 |

The server also requires `"confirm": true` in the request body for the confirmed actions, so a
script cannot skip the confirmation either.

**Manual jobs run inside the API process**, one at a time. A second request while one runs is
refused with "A manual job is already running". They use the same course leases as the
scheduled `pnpm indexer sync:*` jobs, so a course is never processed twice at once. A job
needs the full indexer configuration in the API's environment: Moodle, extraction, embeddings,
search, and `SYNC_STATE_DIR` pointing at the same store as the indexer.

**Arbitrary course IDs.** Re-index and retry accept only courses in `SYNC_COURSE_IDS` (or any
course with `SYNC_ALL_COURSES=true`) and only resources already in the state store. Course
names are looked up in Moodle only for courses in the selection or the state store. A hand-made
request cannot make the service account read anything new.

## Security

- **Authentication**: the page signs in with MSAL (authorization code flow with PKCE) through
  its own **single-page-app registration**. It gets an access token for the API's
  `access_as_user` scope and sends it as `Authorization: Bearer`. The API validates it like any
  other token (phase 13); the admin registration's client ID must be in
  `ENTRA_ALLOWED_CLIENT_APP_IDS`.
- **CSRF**: no cookies or other ambient credentials are used, so a forged cross-site request
  arrives unauthenticated. Mutations also require JSON (a cross-site form cannot send it, and
  CORS is never granted). They require an `Origin` equal to `ADMIN_PUBLIC_ORIGIN` (or the
  request's own host) when the browser sends one, and refuse `Sec-Fetch-Site: cross-site`.
- **Content Security Policy**: no inline script or style, no `eval`; scripts only from the API
  itself. `frame-ancestors 'none'`. MSAL Browser 5.25.1 is served from the API (pinned,
  checked at startup), not from a CDN.
- **No HTML from data**: the page builds every element with DOM methods and `textContent`; a
  test fails if `innerHTML` or similar appears in the script.
- **Validation**: every request body is checked with a strict Zod schema; unknown fields are
  refused.
- **Audit**: every mutation attempt by a signed-in user is written to the audit trail:
  accepted, refused (with the reason, including missing roles and missing confirmation) or
  failed. A record holds action, outcome, reason code, actor (object ID, admin roles, sign-in
  method), target IDs and correlation ID. It holds no names, email addresses or free text other
  than the optional reference. If the audit record cannot be written, the request fails.
- **Accessibility**: skip link, landmark regions, one `h1` per page that receives focus on
  navigation, `aria-current` in the navigation, tables with captions and column headers,
  labelled form fields, a `role="status"` live region for results and `role="alert"` for
  errors (with the correlation ID to quote), and a modal `<dialog>` for confirmations (Escape
  cancels). Light and dark colour schemes.

## Setup

1. **App roles** on the API registration: _App roles → Create app role_, allowed member type
   _Users/Groups_, for each of `EHub.User`, `EHub.ContentAdministrator`,
   `EHub.ApplicationAdministrator`, `EHub.Auditor`. Assign them to people under _Enterprise
   applications → E-Hub Answer API → Users and groups_.
2. **Admin page registration**: _App registrations → New registration_, e.g. `E-Hub Admin
(<environment>)`, single tenant.
   - Platform **Single-page application**, redirect URI `https://<api>/admin/`.
   - _API permissions_: E-Hub Answer API → `access_as_user` (delegated), then grant admin
     consent.
   - No client secret: an SPA cannot keep one.
3. Settings on the API:

```bash
ADMIN_UI_ENABLED=true
ADMIN_SPA_CLIENT_ID=<admin page registration client ID>
ENTRA_ALLOWED_CLIENT_APP_IDS=<bot client ID>,<admin page client ID>
ADMIN_PUBLIC_ORIGIN=https://<api host>       # recommended; the origin checked on mutations
ADMIN_STATE_DIR=.ehub/admin-state            # audit trail and usage events
ADMIN_RETENTION_DAYS=90                      # 7-730
```

In production the API refuses to start with the admin area enabled but no
`ADMIN_SPA_CLIENT_ID`, or with an `ADMIN_SPA_CLIENT_ID` missing from
`ENTRA_ALLOWED_CLIENT_APP_IDS`.

**Development**: with `API_DEV_MOCK_IDENTITY=true`, `API_DEV_MOCK_ROLES` (e.g.
`EHub.ContentAdministrator`) gives the mock user roles. The page then signs in as the mock user
without Entra and shows a "Development mode" banner. Both settings are ignored outside
development.

## Stored data and retention

`ADMIN_STATE_DIR` holds daily JSON-lines files, readable by their owner only:

- `audit/YYYY-MM-DD.jsonl`: administrative actions (above).
- `usage/YYYY-MM-DD.jsonl`: one record per answer (time, status, correlation ID; never the
  question or answer) and per feedback rating (time, answer ID, rating, pseudonymous user key).

Days older than `ADMIN_RETENTION_DAYS` are deleted at startup and daily. Lines that do not
validate are skipped and counted on the dashboard (`unreadableEvents`). Identity records keep
their own limits (phase 14: last 2,000 mapping failures, invalidations for 2 hours). Like the
other file stores, this works for one machine; several instances need shared storage
(phase 19).

## Not verified

- **MSAL sign-in against the real tenant.** The page code follows MSAL Browser 5's documented
  redirect flow (`initialize`, `handleRedirectPromise`, `loginRedirect`, `acquireTokenSilent`,
  `acquireTokenRedirect`). The browser tests use the development mock identity, because they
  cannot sign in to Entra. Check sign-in and silent token renewal once the registration
  exists.
- Whether silent renewal works under the CSP in every browser. The CSP allows the Entra
  authority as a frame and connect source, as MSAL's hidden-iframe renewal needs. If renewal
  fails, the page falls back to a redirect.
