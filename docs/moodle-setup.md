# Moodle setup: restricted external service

The assistant reads Moodle E-Hub through a dedicated **external service** with a dedicated
**service account** and a **token restricted to that service**. The goal is that a leaked token
can do as little as possible: read selected course content and enrolments, nothing else.

Menu paths below are for Moodle 4.x/5.x (Boost theme). Labels can differ slightly between
versions; where this guide says "confirm on your site", check the screen rather than relying on
the guide.

## 1. Enable web services and the REST protocol

1. _Site administration → General → Advanced features_: enable **Enable web services**.
2. _Site administration → Server → Web services → Manage protocols_: enable **REST protocol**
   only. Leave SOAP and XML-RPC disabled.

## 2. Create the service account

1. _Site administration → Users → Add a new user_.
   - Username: e.g. `ehub_assistant`
   - Authentication: **No login** (`nologin`) or **Manual** with a long random password that is
     never used. The account must not be able to sign in interactively.
   - Email: a monitored IT mailbox.
2. Do **not** give this account Site administrator rights.

## 3. Create a role for the service

_Site administration → Users → Permissions → Define roles → Add a new role_

- Base it on **No role**; name it e.g. `E-Hub Assistant (web service)`.
- Context types where it can be assigned: **System** and **Category**.
- Allow:
  - `webservice/rest:use`
  - The capabilities Moodle lists as **Required capabilities** for each function in step 4.
    Typically these include `moodle/course:view`, `moodle/course:viewhiddenactivities`,
    `moodle/course:viewhiddensections`, `moodle/course:viewparticipants`,
    `moodle/user:viewdetails` and `moodle/course:enrolreview`. **Confirm on your site**: add a
    capability only when the function list shows it as required or a call fails with
    `nopermissions`/`requireloginerror`.
- Do not allow `moodle/course:update`, `moodle/user:update`, `moodle/site:config` or any
  `…:manage` capability. The assistant never writes to Moodle.

Assign the role with the narrowest scope that works:

- **Preferred:** _Site administration → Courses → Manage courses and categories →_ the
  category holding the E-Hub courses _→ Assign roles_. The service account then sees only
  courses in that category.
- **Only if required:** _Site administration → Users → Permissions → Assign system roles_.
  This exposes every course on the site.

`moodle/user:viewhiddendetails` is needed only if users' e-mail addresses are hidden and
e-mail identity mapping (phase 14) is used. Grant it only then.

## 4. Create the external service

_Site administration → Server → Web services → External services → Add_

- Name: `E-Hub Teams Assistant`
- Short name: `ehub_teams_assistant`
- **Enabled**: yes
- **Authorised users only**: yes, then add only the service account under _Authorised users_
  (optionally with an IP restriction here as well).
- **Can download files**: yes. Required for course files through
  `webservice/pluginfile.php`.
- **Can upload files**: no.
- Required capability: leave empty (the role controls access).

Then _Functions → Add functions_ and add exactly these six, nothing else:

| Function                        | Used for                                    |
| ------------------------------- | ------------------------------------------- |
| `core_webservice_get_site_info` | Connectivity check (`moodle:ping`, phase 3) |
| `core_course_get_courses`       | Course discovery                            |
| `core_course_get_contents`      | Sections, activities and file metadata      |
| `core_enrol_get_enrolled_users` | Enrolment checks for course authorisation   |
| `core_enrol_get_users_courses`  | A user's enrolled courses                   |
| `core_user_get_users_by_field`  | Identity mapping (Entra ID → Moodle user)   |

When adding each function, note the **Required capabilities** column and make sure the role
from step 3 grants them.

## 5. Create the token

_Site administration → Server → Web services → Manage tokens → Create token_

- User: the service account
- Service: `E-Hub Teams Assistant` (never "Moodle mobile web service")
- **IP restriction**: the outbound IP addresses the indexer and API run from. Leave empty only
  for local development.
- **Valid until**: set an expiry (e.g. 6–12 months) and record the rotation date. Token rotation
  is documented in phase 20.

The token is shown in full only once. Store it directly in:

- local development: `.env` as `MOODLE_TOKEN` (never committed);
- Azure: Key Vault secret referenced by the app setting (phase 19).

Never paste it into tickets, chat, e-mail or screenshots.

## 6. Configure the assistant

```bash
MOODLE_BASE_URL=https://your-moodle-host        # site root, no trailing path
MOODLE_TOKEN=                                   # from step 5
# Optional limits
MOODLE_REQUEST_TIMEOUT_MS=30000
MOODLE_DOWNLOAD_TIMEOUT_MS=120000
MOODLE_MAX_DOWNLOAD_BYTES=104857600
MOODLE_MAX_RETRIES=3
```

`MOODLE_BASE_URL` may include a sub-directory if Moodle is installed under one
(`https://host/moodle`). A pasted `…/webservice/rest/server.php` or `…/login/index.php` suffix
is removed automatically. https is mandatory when `NODE_ENV=production`.

## 7. Verify

From phase 3, `pnpm indexer moodle:ping` calls `core_webservice_get_site_info` and reports
success or a sanitized failure category. Until then, check in Moodle:

- _External services → E-Hub Teams Assistant → Functions_ lists exactly the six functions.
- _Manage tokens_ shows the token bound to the service account and service, with IP
  restriction and expiry set.

## How the client protects the token

- REST calls are sent as **HTTP POST** with the token in the form body, so it does not appear in
  URLs, proxy logs or Moodle's web-server access logs.
- File downloads add the token only to the request sent to the Moodle host. Stored and logged
  URLs are the token-free source URL. Redirects are followed manually, only to approved hosts,
  and never receive the token.
- Errors carry sanitized messages and structured fields only, never the underlying exception,
  Moodle's `debuginfo`, or request parameters.
- The token value is registered with the logger's redaction so it is scrubbed even if it appears
  somewhere unexpected.

## Troubleshooting

| Error code (category)                   | Likely cause                                                  |
| --------------------------------------- | ------------------------------------------------------------- |
| `invalidtoken` (authentication)         | Token mistyped, deleted, or created for another service       |
| `invalidtimedtoken` (authentication)    | Token expired: create a new one and rotate                    |
| `invalidiptoken` (authentication)       | Caller IP not in the token's IP restriction                   |
| `accessexception` (authorization)       | Function not added to the service, or user not authorised     |
| `nopermissions` / `requireloginerror`   | Role lacks a capability or is not assigned in that course     |
| `webservicesnotenabled` (authorization) | Web services or the REST protocol is disabled                 |
| `unexpected_html_response` (api)        | Maintenance mode, login page or a proxy error page            |
| `login_redirect` (authentication)       | File download rejected: check _Can download files_ on service |
| `http_429` (rate_limit)                 | A proxy or WAF in front of Moodle is throttling the client    |
