# Change management

How changes reach production, and which ones need more than a deployment. Written for one
administrator who is also the developer: the point is not approval theatre, it is that the risky
changes are the ones that do not look like changes.

## Branch and gate

One branch per phase or change, as the repository has been built (`phase/01-foundation` through
`phase/20-production`). Commit only after the full gate passes:

```bash
pnpm install && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test \
  && pnpm test:security && pnpm test:acceptance && pnpm build
```

Then, for anything that will be deployed:

```bash
pnpm release:verify -- --env-file infrastructure/environments/release.env
```

Run each step and check its exit code. Do not pipe a gate into anything that swallows the status;
a gate whose failure you cannot see is not a gate.

## Change classes

| Class                     | Examples                                                                                                         | What it needs                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — routine**           | A bug fix, a doc change, a card tweak, a prompt wording change                                                   | The gate, the release report, deploy, `pnpm preflight`.                                                                                             |
| **B — scope**             | Adding a Moodle course, adding pilot users, enabling the administration area, turning on hidden-content indexing | Written decision of who asked and why, a named course owner where relevant, then class A.                                                           |
| **C — interface or data** | Search index schema, embedding model, state file format, the answer API's contract, the Teams manifest           | Class A plus a migration plan and a tested rollback, because the rollback is no longer just the image (docs/rollback.md).                           |
| **D — security**          | Authorisation logic, token handling, redaction, identity matching, anything in `tests/security`                  | Class A plus `pnpm test:security` reviewed control by control, and a new acceptance or security test that fails before the change and passes after. |

Class B is the one that gets underestimated. Adding a course does not change a line of code and
changes what the assistant will say to 90 people.

## Changes that widen scope

Each of these is a decision, recorded before it is made:

- **A new course.** Who owns the content, is it current, and is it appropriate for every person
  enrolled in it? Then add the ID to `SYNC_COURSE_IDS`, deploy, sync that course, and ask it two
  real questions (docs/operations-runbook.md, procedure 2).
- **More users.** Add them to the pilot group. Nothing else changes; their access still comes from
  their own Moodle enrolments.
- **Hidden content** (`SYNC_INCLUDE_HIDDEN=true`). Material hidden from staff in Moodle becoming
  answerable through a bot is a deliberate decision, not a tuning option. The default is off.
- **The administration area** (`ADMIN_UI_ENABLED=true`). Needs `ADMIN_SPA_CLIENT_ID` and the app
  roles assigned to a named, short list.
- **Channel or group-chat use.** Requires a manifest change and re-consent, and changes who can
  see an answer. Out of scope for the pilot by construction.
- **Uploads.** No upload path exists. Adding one is a new feature with its own threat model, not a
  configuration change.

Anything that moves a pilot control (docs/production-deployment.md) is class B at least.

## Deploying

docs/production-deployment.md has the full procedure. For a routine change to an already-deployed
environment:

```bash
infrastructure/scripts/what-if.sh prod                 # what would change, before it changes
infrastructure/scripts/deploy.sh prod --stage apps     # build, push, deploy the services
pnpm preflight                                         # in the deployed environment
```

Deploy one change at a time when you can. Two changes in one deployment means a failure tells you
nothing about which one caused it, and the rollback undoes both.

## Recording a change

Keep it short enough that it actually gets written. Per change:

```
Date:        <date>
Change:      <one line>
Class:       A / B / C / D
Commit:      <short commit>   Image tag: <tag>
Why:         <one or two lines>
Gates:       release report <verdict>; preflight <pass/fail> on <date>
Rollback:    <tag or commit>, and anything the image rollback would not undo
Follow-up:   <if any>
```

For class B, add who asked for it and who owns the content. For class C, add the migration steps
and what proved the rollback works. For class D, add which test now covers it.

Architectural decisions — the ones that explain _why_ the system is shaped as it is — go in
docs/decisions.md instead, one short section each, as they have throughout.

## Changing the gates themselves

Loosening a check deserves more scrutiny than the change that prompted it. Specifically:

- Do not mark a test skipped to get a release out. The security and acceptance reports treat a
  skipped test as a failure precisely so this cannot be a quiet decision
  (docs/decisions.md).
- Do not add a production exemption to the startup validation. If a production control is wrong
  for your environment, the control or the environment is wrong; an escape hatch becomes
  permanent.
- If a preflight finding is genuinely a false positive, fix the finding and add the case to
  `packages/shared/src/production/productionReadiness.test.ts`, so the next person inherits the
  correction rather than the workaround.

## Dependencies

`pnpm-lock.yaml` is committed and its checksum is in every release report. Update dependencies
deliberately, as their own class A change, with the full gate — never as a side effect of
something else. `pnpm secrets:scan` and the security tests run over the result, which is the
point of doing it separately.
