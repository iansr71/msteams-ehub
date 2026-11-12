# Moodle production setup

What has to exist on the E-Hub Moodle server before the assistant can read anything, and why
each restriction is there. docs/moodle-setup.md covers the same ground for a development server;
this is the production version, with least privilege taken seriously.

The assistant only ever reads. It never writes to Moodle, never enrols anyone, and never changes
a course. If the service account can do more than read, the assistant is not what made it
possible.

## 1. The service account

Create a dedicated Moodle account — not a person's, and not an existing administrator.

- Authentication: manual accounts, with a long random password nobody needs to keep.
- Name it for what it is, for example `E-Hub Assistant (service)`.
- Turn email notifications off: this account is not a person and should not receive digests.
- Do not give it the site administrator role.

If the account is ever disabled, or its password is changed, the token keeps working — Moodle
tokens are independent of the password. Deleting the account does revoke the token.

## 2. The web-service role and its functions

The assistant calls exactly six Moodle web-service functions, and no others:

| Function                        | Why                                                         |
| ------------------------------- | ----------------------------------------------------------- |
| `core_webservice_get_site_info` | Confirms the token works and lists the available functions. |
| `core_course_get_courses`       | Finds the selected courses and their names.                 |
| `core_course_get_contents`      | Sections, activities and file metadata for a course.        |
| `core_enrol_get_users_courses`  | What a signed-in member of staff may read.                  |
| `core_enrol_get_enrolled_users` | Confirms an enrolment when resolving a user.                |
| `core_user_get_users_by_field`  | Maps an Entra account to a Moodle account by email.         |

Create a role (Site administration → Users → Permissions → Define roles) with the read
capabilities those functions need — `webservice/rest:use`, `moodle/course:view` and the course
content viewing capabilities — and nothing that allows writing. Assign the role to the service
account at system level, then add it to each selected course if your capability model needs it.

Create an external service (Site administration → Server → Web services → External services)
containing only the six functions above, restricted to authorised users, and authorise the
service account on it.

_Proof:_ `pnpm indexer moodle:ping` lists exactly those six functions. It fails if any is
missing, and reports any extra function the service exposes. An extra function is not an error
in the strict sense, but it widens what a leaked token could do, so remove it.

## 3. The token and its expiry

Issue the token for the service account on that external service (Site administration → Server →
Web services → Manage tokens).

- Set a deliberate expiry date. "Never" means nobody ever revisits it, and a token with no end
  date is a credential with no rotation.
- Put the token straight into Key Vault as `moodle-token`. It should not pass through a file in
  this repository, a chat message, a ticket, or an email.
- Record the expiry date in `MOODLE_TOKEN_EXPIRES_ON` in the environment file. Nothing in the
  Moodle API reports a token's expiry, so this recorded date is the only thing that can warn you;
  `pnpm preflight` warns from 30 days out and fails once the date has passed.

Rotation is docs/token-rotation.md. Do that procedure once before go-live, so the first real
rotation is not the first time anyone has tried it.

## 4. IP restriction (optional)

The token is a bearer credential: whoever holds it can read everything the service account can.
Restricting where it may be used from limits the damage if it leaks.

With `EHUB_ENABLE_VNET=true` the Azure deployment egresses through a single NAT gateway address
(docs/infrastructure.md). Add that address to the Moodle token's IP restriction, or to the
server's firewall.

Two consequences to accept first: a developer's machine can then no longer run `pnpm diagnose`
against production, and if the gateway address ever changes the assistant stops working with an
authentication-looking error. Note the address in the deployment record.

## 5. Course selection

Only the courses listed in `SYNC_COURSE_IDS` are read. Find their IDs with:

```bash
pnpm indexer moodle:courses --search "peel"
```

Hidden courses and hidden activities are excluded unless `SYNC_INCLUDE_HIDDEN=true`, which the
pilot leaves off: material hidden from staff in Moodle should not become answerable through a
bot.

Adding a course to the list is a change, not a configuration tweak: it widens what the assistant
can say. docs/change-management.md.

## 6. What Moodle content the assistant trusts

None of it, in the instruction sense. Course material is treated as untrusted data throughout:
text that looks like an instruction to the model is defused rather than followed, and hidden HTML
and PDF text are stripped of their formatting tricks before indexing (docs/security.md,
docs/threat-model.md). Staff who can edit course content cannot use it to change what the
assistant does, or to widen what anyone can read.

What the assistant cannot do is tell whether the content is _correct_. If a course page is out of
date, the answer will be too, with a citation that leads to the page saying it. That is a content
ownership question, which is why the pilot's course list is deliberately short and owned.
