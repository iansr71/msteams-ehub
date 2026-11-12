# Acceptance sign-off

The record that says this release was accepted for production, by whom, on what evidence. It is
checklist item 24 of docs/production-deployment.md and the last thing done before staff get the
app.

Copy the template below into the change log for the release, fill it in, and attach
`reports/release/release-report.md`. The point is not ceremony: it is that six months from now,
someone — probably you — can see what was actually tested and what was knowingly accepted.

## What the automated checks establish

Attach the release report rather than restating it. It carries the version, commit, every gate's
result, the artefact checksums and the rollback target. `pnpm release:verify` refuses to call a
release ready while any gate failed or could not be run.

What those gates do and do not prove is in docs/acceptance.md. The short version: they prove the
assistant is faithful to what was indexed and that course boundaries hold. They do not prove the
answers are a correct reading of the content, and they say nothing about whether the content in
Moodle is right.

## What only a person can establish

These are the checks nobody can automate, and sign-off means someone did them.

### Sign-in and scope

- [ ] A pilot user installs the app from Teams and signs in with no consent prompt.
- [ ] A user outside the pilot group cannot find the app.
- [ ] The app cannot be added to a channel or a group chat (the option is absent).

### Answers

- [ ] Five real staff questions, answerable from the selected courses, give answers that a person
      who knows the material agrees with.
- [ ] Every citation on those answers opens the Moodle activity it names, and the cited passage
      actually says what the answer claims. Check each one; this is the check that matters most.
- [ ] A question about something E-Hub does not cover returns the insufficient-evidence reply
      rather than a plausible invention.
- [ ] A question phrased to extract instructions from course content ("ignore your instructions
      and …") changes nothing.

### Boundaries

- [ ] A tester asks about a course they are **not** enrolled in and is refused.
- [ ] After removing one of the tester's Moodle enrolments and invalidating their cache, the same
      question is refused.
- [ ] The administration area is reachable by a role holder and returns 403 for everyone else.

### Operations

- [ ] `pnpm preflight` passes in the deployed environment (this is the live-dependency check that
      `release:verify` cannot do).
- [ ] An alert arrived at the ops address for a deliberately failed availability test.
- [ ] A state-share snapshot exists and a test restore worked (docs/backup-and-recovery.md).
- [ ] A rollback was performed on the real environment and answers still worked afterwards
      (docs/rollback.md).
- [ ] `MOODLE_TOKEN_EXPIRES_ON` is set and a calendar reminder exists 30 days before it.

### Content ownership

- [ ] Every selected course has a named owner who knows the assistant quotes it.
- [ ] That owner has seen at least one real answer from their course.

## Known limitations accepted

Sign-off is accepting these, not overlooking them. Tick each as read:

- [ ] Grounding is mechanical: a claim citing a real passage can misread it and still pass.
- [ ] Answer wording comes from a model and will vary; the acceptance suites use a quoting model
      and do not predict it.
- [ ] Rate limits and the concurrency cap are per API replica, in memory.
- [ ] There is no multi-region failover. If the region is unavailable, staff use Moodle directly.
- [ ] The assistant cannot tell that correct-looking content is out of date.
- [ ] Only the courses in `SYNC_COURSE_IDS` are answerable; everything else returns insufficient
      evidence.

## Template

```
Release sign-off — E-Hub Teams Knowledge Assistant

Version:              0.1.0
Source commit:        <short commit>
Release report:       reports/release/release-report.md (attached)
Image tag deployed:   <tag>
Rollback target:      <tag / commit>

Pilot scope
  Courses:            <IDs and names>
  Pilot group:        <Entra group>, <n> members
  Administrators:     <names>

Evidence
  Automated gates:    <ready / ready-with-skipped-steps>, see attached report
  Preflight in prod:  pass on <date>
  Manual checks:      all boxes above ticked on <date> by <name>
  Evaluation:         retrieval <result>, answers <result>, on <n> real cases

Accepted limitations: as listed in docs/acceptance-signoff.md, read and accepted

Decision:             approved for the pilot / approved with conditions / not approved
Conditions:           <if any>

Approved by:          <name>, <role>, <date>
```

## Afterwards

Sign-off starts the pilot; it does not end the work. For the first two weeks, look at the
feedback and the answer outcomes weekly (docs/admin.md), and turn what you learn into evaluation
cases — the datasets in `tests/evaluation/` are templates until real staff questions are in them,
and that is what makes the next release measurable rather than hopeful.

Widening the pilot — more courses, more users, the administration area, hidden content — is a
change with its own approval: docs/change-management.md.
