# Support and troubleshooting

Things staff report, what they usually mean, and how to fix them. For outages and anything
unsafe, docs/incident-response.md.

## What to ask for first

The reference. Every answer card ends with `Reference: <correlation ID>`, and every error card
carries one too. With it you can trace one question through the bot, the API, retrieval and the
model (docs/operations-runbook.md, procedure 14). Without it you are guessing.

Also useful, and quick to ask: what exactly they typed, which course they expected the answer to
come from, and whether it has ever worked for them.

What you will **not** find in the logs: the question text, the answer, or any passage from a
document. That is deliberate (docs/security.md). So the person's own account of what they asked
is primary evidence, not a formality.

## "I can't find the app in Teams"

- They are not in the pilot group. Membership of the approved security group is what grants it
  (docs/teams-deployment.md).
- They are in the group but the policy has not propagated yet. This can take a few hours.
- They are looking in the wrong place: it is a personal app, found under **Apps**, and it cannot
  be added to a channel or a group chat at all — the manifest has no such scope.

## "It says it couldn't confirm what I have access to"

This is the fail-closed message: the assistant could not establish what the person may read, so
it refused rather than guessing. In order of likelihood:

1. **No Moodle enrolments.** `pnpm authorization courses --entra-object-id <guid>` reads Moodle
   directly. No courses means nothing to answer from; the fix is an enrolment in Moodle.
2. **Identity not matched.** Their Entra account could not be matched to a Moodle account —
   usually a different email address in the two systems. `pnpm identity resolve
--entra-object-id <guid>` shows what matching decided, and `pnpm identity failures` lists
   denied attempts. Map explicitly only after confirming both accounts are the same person
   (runbook procedure 7).
3. **Moodle unreachable, or the token expired.** Then it affects everyone, not one person:
   `pnpm preflight`.

Branch staff who use Teams as guests on personal email addresses are the common case here: their
Teams identity has no relationship to their Moodle account, so an explicit mapping is usually
needed. Confirm each one against the person, not against a list.

## "It says there isn't enough information"

The insufficient-evidence reply, which is the assistant working correctly: nothing retrieved
supported an answer, so it said so instead of inventing one. Check in this order:

1. **Is the course indexed?** Only the courses in `SYNC_COURSE_IDS` are, and the pilot list is
   short on purpose.
2. **Is it enrolled?** Retrieval is limited to their own courses; the material may exist but not
   for them.
3. **Is the wording very different from the source?** Try the question against retrieval
   directly: `pnpm api retrieve --question "<their question>" --course-id <ids> --excerpts`. If
   the passage comes back, it is a generation problem; if it does not, it is retrieval, and the
   question belongs in `tests/evaluation/retrieval-cases.json` so it gets measured.
4. **Is the content in a form that could be extracted?** A scanned PDF with no text layer, or a
   photograph of a policy, indexes as nothing. `pnpm indexer extract:test --course-id <id>
--resource-id <id>` shows what was extracted.

## "The answer is out of date"

Follow the citation. If the Moodle page says what the answer said, the content is stale and only
the course owner can fix it (runbook procedure 13). If the page is already correct, the index is
behind: re-index that resource (procedure 1).

Withdrawn guidance that is still being quoted is more urgent: hide or delete it in Moodle and
reconcile (procedure 4), which removes it from the index.

## "The answer is wrong"

Distinguish three things, because the fixes are different:

- **Wrong because the source is wrong** — content ownership (above).
- **Wrong because it quoted the right passage and misread it** — a real limitation. The grounding
  checks are mechanical: they catch invented numbers, pages, documents and links, but not a
  misreading of a passage that is genuinely cited (docs/acceptance.md). Record the case; if it
  recurs in one subject, narrow the course list.
- **Wrong because it answered from nothing** — a grounding defect, and a serious one. Capture the
  correlation ID and treat it as an incident.

In all three, ask them to use the thumbs-down in the card. It is recorded against the answer's
correlation ID, without the question text, so patterns become visible in the administration area
(docs/admin.md).

## "It's slow"

A normal answer takes a few seconds: embedding the question, retrieval, then the model. Slower
than that is usually the model deployment under load or at its quota. `pnpm diagnose` reports the
latency of each dependency, and Application Insights has the breakdown per correlation ID
(docs/observability.md).

Two limits can also produce apparent slowness, both by design: the per-user rate limit
(`API_RATE_LIMIT_QUESTIONS`) and the concurrency cap (`API_MAX_CONCURRENT_ANSWERS`). A person who
asked a burst of questions is being throttled, not failed.

## "The links don't work"

- **A link opens Moodle but shows nothing:** they are not enrolled in that course, or the
  activity is hidden. The citation was valid; Moodle is enforcing its own permissions.
- **There are no links at all:** `TEAMS_ALLOWED_LINK_HOSTS` does not include the Moodle host, so
  every link is stripped. `pnpm preflight` reports this as `teams.linkHosts`.
- **A link goes to the wrong page:** a citation defect. Capture the reference and the resource,
  and check suite 10's assumptions (docs/acceptance.md).

## Things that are working as intended

Worth knowing, so they are not chased as faults:

- It will not answer from a course the person is not enrolled in, even if they know the content
  exists.
- It will not accept an instruction found inside course material, however it is phrased.
- It will not take a file: there is no upload path in the pilot.
- It will not work in a channel or group chat.
- It says "not enough information" rather than guessing, and that is the behaviour that makes the
  rest trustworthy.

## When to escalate to yourself

Stop triaging and treat it as an incident (docs/incident-response.md) if: someone saw content
from a course they are not enrolled in; a credential may have been exposed; answers are
confidently wrong about clinical procedure; or nobody can get an answer at all.
