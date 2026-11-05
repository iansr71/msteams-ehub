# Course authorisation from Moodle

Phase 14 decides which E-Hub courses each signed-in user may ask about. The decision comes from
Moodle itself and is made **before** any search runs. It is enforced inside the Azure AI Search
request, never by filtering results afterwards and never by the model.

```text
validated Entra token (phase 13)
  └─ 1. Moodle identity: which Moodle account is this person?      MoodleIdentityResolver
  └─ 2. enrolments: which courses is that account enrolled in?      MoodleEnrollmentService
  └─ 3. cache: reuse that answer for a few minutes                  AuthorizationCache
  └─ 4. course filter: tenantId, isActive, courseId in the set      SearchAuthorizationFilterBuilder
        └─ Azure AI Search request (filter applied inside the query, vector pre-filter)
              └─ every hit re-checked against the set; any stray hit fails the request
                    └─ only those chunks go to the model; citations re-checked against the set
```

`AuthorizedCourseService` runs steps 1 to 3 for every question. The answer API passes the result
to the RAG engine as the user's authorised courses. Nothing in the request body can widen the
set:

- `selectedCourseIds` can only narrow it.
- A selected course outside the set gets **403 `course_not_authorized`**. It is checked in the
  RAG service and again in the search filter builder.

## 1. Identity mapping

The order is fixed, and the first rule that applies decides:

| #   | Rule                                                                                                                        | Notes                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | **Explicit mapping** approved by an administrator (`pnpm identity map`)                                                     | Moodle must confirm the account exists and is active. If not, the user is denied: nothing else is tried.       |
| 2   | **Email**: the token's `email` claim matches **exactly one** Moodle account (`core_user_get_users_by_field`, field `email`) | Compared case-insensitively. Two or more matches are denied (`ambiguous_email`) and the UPN rule is not tried. |
| 3   | **UPN rule**: the token's `upn` claim through `IDENTITY_UPN_USERNAME_RULE`                                                  | Off by default. Members only, listed domains only, never `preferred_username`, never guest UPNs (`…#EXT#@…`).  |
| 4   | Otherwise **denied** (`no_match` / `no_usable_claims`)                                                                      | The user gets "Your account is not linked to E-Hub" and an audit record is written.                            |

An account counts as active only when Moodle reports `suspended: false`. An account with
`auth = nologin` or `confirmed = false` is denied. If Moodle does not report `suspended` at all
(the field is hidden from the service account), the user is denied with `moodle_status_unknown`
rather than assumed active.

**Why the email claim is trusted.** The API accepts tokens from Skin Renewal's tenant only
(phase 13). In that tenant, a member's email is set by administrators, and a guest's is the
address they were invited with and redeemed. Users cannot set it themselves. The
"nOAuth"-style risk of trusting email applies to multi-tenant apps that accept other tenants'
tokens. Two consequences remain:

- An administrator who changes a user's email in Entra or Moodle changes the mapping.
- Two Moodle accounts sharing an email are denied, not guessed.

**Case sensitivity.** `core_user_get_users_by_field` uses an exact SQL `IN` match. On MySQL or
MariaDB with the default collation that ignores case; on PostgreSQL it does not. The resolver
sends both the lower-cased email and the email exactly as issued, then compares
case-insensitively. A Moodle email that differs in case from both forms (for example
`THANDI@…` against a token's `Thandi@…`) is not found on PostgreSQL. Fix the Moodle record, or
add an explicit mapping.

**UPN rule** (`IDENTITY_UPN_USERNAME_RULE`):

| Value            | Moodle username tried      | Use when                                                         |
| ---------------- | -------------------------- | ---------------------------------------------------------------- |
| `none` (default) | none                       | Email matching is enough                                         |
| `upn`            | `thandi@skinrenewal.co.za` | Moodle accounts use the full UPN as username (e.g. OAuth2 login) |
| `upn-local-part` | `thandi`                   | Moodle usernames are the part before `@`                         |

`IDENTITY_UPN_DOMAINS` (required with a rule) lists the domains it applies to. The rule needs
the `upn` optional claim in the API registration (docs/entra-sso.md). Moodle usernames are
lower-case, and Moodle rejects a lookup value it would have to clean, so the username is sent
lower-cased.

### Guests (branch staff on personal email addresses)

Guests are matched by email only: their UPN is never a Moodle username. For a guest, the email
claim should be the invited personal address. That address must be the email on exactly one
Moodle account. **Not verified in the tenant yet:**

- that guest tokens carry the `email` claim with the invited address;
- that each guest's Moodle account uses that same address.

Check both with `pnpm identity resolve` for one real guest before rollout. Where the addresses
differ, use `pnpm identity map`.

## 2. Enrolments

`core_enrol_get_users_courses` returns the account's **active** enrolments: Moodle calls
`enrol_get_users_courses($userid, true)`. It returns only courses the service account can see
participants in.

- Courses with `visible = 0` are left out: students cannot open them in Moodle.
- A course whose visibility Moodle does not report is left out too.
- More than 1,000 courses is treated as an invalid response and refused rather than truncated.

The course filter then limits search to those courses. Only courses that were indexed (phase 11)
have content, so an enrolment in an unsynchronised course simply finds nothing.

Each chunk's `courseId` (filterable, set from Moodle by the indexer, validated on upload) is the
"allowed course" metadata the filter uses. Each chunk belongs to exactly one course, so there is
no separate allowed-courses field (docs/decisions.md).

Not covered, because Moodle does not report them through these functions:

- section and activity restrictions (availability conditions);
- group mode;
- per-activity permissions inside a course.

Hidden sections and activities are already excluded at indexing time (`SYNC_INCLUDE_HIDDEN`,
phase 11). An enrolled user can ask about every indexed resource in the course.

## 3. Cache and revocation

| Setting                           | Default | Meaning                                                                                         |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `AUTHZ_CACHE_TTL_SECONDS`         | 300     | A user's courses are reused this long (10–3600)                                                 |
| `AUTHZ_STALE_GRACE_SECONDS`       | 0       | While Moodle is unreachable, an expired grant may be reused this much longer (0–900). 0 = never |
| `AUTHZ_CACHE_MAX_ENTRIES`         | 5000    | Oldest entries are dropped beyond this                                                          |
| `AUTHZ_INVALIDATION_POLL_SECONDS` | 5       | How often the API reads invalidations written by the commands                                   |

Denials are cached for at most 60 seconds and are never served stale.

Revocation takes effect:

1. **On cache expiry**: at most `AUTHZ_CACHE_TTL_SECONDS` after Moodle changes.
2. **On explicit invalidation**: `pnpm authorization invalidate --entra-object-id <id>` (or
   `--all`). `identity map` and `identity unmap` invalidate the user automatically. The API
   applies it within the poll interval.
3. **On the enrolment sync job**: `pnpm authorization sync`, run on a schedule (for example
   every 15 minutes). It re-reads Moodle for every known user (explicit mappings plus everyone
   who has signed in) and invalidates each user whose courses or mapping changed.

An invalidation is never overridden by the stale grace. If the API cannot read invalidations,
it trusts no cached entry and asks Moodle again.

**Failing closed.** If Moodle or the identity store cannot be reached and no grant is allowed
by the policy above, the user gets **503 `authorization_unavailable`** ("Course access cannot
be checked") and no search runs. A Moodle error is never treated as "no courses" or as a
mapping failure; the exception is a lookup value Moodle itself rejects as malformed, which
cannot match anyone.

## 4. Administrator commands

All print JSON with IDs, reason codes and course IDs. Email and UPN appear only masked
(`t…@skinrenewal.co.za`). Names are never printed.

```bash
pnpm identity resolve --entra-object-id <id> [--email <address>] [--upn <upn>]
pnpm identity map --entra-object-id <id> --moodle-user-id <n> --approved-by <name> [--reference IT-1234]
pnpm identity unmap --entra-object-id <id>
pnpm identity failures [--entra-object-id <id>] [--limit 50]

pnpm authorization courses --entra-object-id <id> [--email <address>] [--upn <upn>]
pnpm authorization invalidate --entra-object-id <id> | --all
pnpm authorization sync
```

- `resolve` and `courses` use the claims from the user's last sign-in. They are a **dry run**:
  nothing is recorded or cached. `--email`/`--upn` check someone who has not signed in yet.
  `courses` asks Moodle directly, bypassing the cache.
- `map` checks with Moodle first and refuses a missing or suspended account.
- The tenant defaults to `AZURE_TENANT_ID` (`--tenant-id` to override). Find a user's object ID
  in Entra ID → Users → the user → Object ID.
- `sync` exits 1 when Moodle could not be asked about some users (those users are left as they
  were).

## 5. What is stored

`IDENTITY_STATE_DIR` (default `.ehub/identity-state`) holds one JSON file, readable by its owner
only:

| Record                | Contents                                                     | Kept            |
| --------------------- | ------------------------------------------------------------ | --------------- |
| Explicit mappings     | object ID, Moodle user ID, approved by, when, reference      | until unmapped  |
| Mapping failures      | object ID, reason, rule, candidate count, account type, time | last 2,000      |
| Identity observations | object ID, email, UPN, account type, last seen               | latest per user |
| Invalidations         | user or all, time, reason                                    | 2 hours         |
| Enrolment snapshots   | object ID, course IDs, time                                  | latest per user |

Observations hold email and UPN so the administrator commands and the sync job can re-run a
mapping. They are the only personal data stored. The file store works for one machine, so the
API and the commands must share the directory. Several API instances need a shared store
(phase 19). The interface (`IdentityMappingRepository`) is ready for one.

## 6. Moodle permissions

The service account needs more than for indexing. The capabilities below come from reading
Moodle's source (`core_user_get_users_by_field`, `core_enrol_get_users_courses`,
`\core\user::get_user_details`); **confirm them on your site** with `pnpm identity resolve` and
`pnpm authorization courses`.

- `moodle/user:viewdetails` at **system** level: user lookups check it in the user's own
  context, which a category role assignment does not reach.
- Email must be visible to the service account, or `core_user_get_users_by_field` returns no
  match. Either add **email** to _Site administration → Users → Permissions → User policies →
  Show user identity_ and grant `moodle/site:viewuseridentity` at system level, or rely on every
  user's email display being "visible to everyone" (not recommended).
- `suspended` must not be a hidden user field for the service account: leave it out of _Hide
  user fields_, or grant `moodle/user:viewhiddendetails`.
- `moodle/user:viewalldetails` only if a UPN rule is used: usernames are returned only with it.
  It also exposes `auth` and `confirmed`, which the resolver then checks.
- In each course: `moodle/course:viewparticipants` (already listed for indexing), so
  `core_enrol_get_users_courses` reports the course.

A second, system-level role holding only these user capabilities keeps course access at
category level. docs/moodle-setup.md lists the steps.

## 7. Configuration

```bash
MOODLE_BASE_URL=…            # as for indexing; MOODLE_TOKEN switches course authorisation on
MOODLE_TOKEN=…
IDENTITY_STATE_DIR=.ehub/identity-state
IDENTITY_EMAIL_MATCHING=true
IDENTITY_UPN_USERNAME_RULE=none
IDENTITY_UPN_DOMAINS=        # e.g. skinrenewal.co.za, with a UPN rule
AUTHZ_CACHE_TTL_SECONDS=300
AUTHZ_STALE_GRACE_SECONDS=0
```

Without `MOODLE_TOKEN` the API falls back to phase 13's interim behaviour: signed-in users get no
courses outside development.

**Production** now starts only with Entra sign-in **and** Moodle course authorisation
configured. The Teams app starts only with its bot registration and single sign-on. The
production blocks from phases 12 and 13 existed because these were missing.
