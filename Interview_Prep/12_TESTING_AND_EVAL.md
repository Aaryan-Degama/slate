# 12 — Testing & Evaluation

## 1. What testing actually exists, precisely

Grep for real: there is **no automated test suite in this repo** — no `*.test.ts`, no `__tests__/`, no Jest/Vitest config beyond what the Vite template ships, no CI test step. `amplify.yml` runs `npm install` and a build; it does not run tests, because there are none wired to run. This is stated plainly, not softened.

What exists instead, in order of how close it gets to real verification:

### a. `docs/TESTING.md` — a manual test checklist, run against the live app
A 36-item checklist against the deployed URL, organized by role (Student, CR, another student in the same section, a BI student, Admin, Permissions), plus a "leave it clean for the demo" section. It's grounded in real, specific data the team could verify by hand: real course-professor pairings ("IML is Dr. Naveen Saini (A), Prof. Krishna P. Singh (B), Dr. Shiv Ram Dubey (C)"), a real starting CR (`IIT2024245`), and exact expected row counts (IT Sec C = 108 students: 62 IIT + 46 IIB). This is a genuinely disciplined checklist — it names exact accounts, exact starting state, and an exact CloudWatch query to confirm Cedar's allow/deny decisions (`aws logs tail ... | grep cedar`). But it is a document a human runs through, not a script; there's no evidence in the repo of it being re-run automatically or on every deploy, and nothing enforces it was followed before any given commit.

### b. `TEST_ACCOUNTS.md` — reproducible test identities
Documents the real Cognito user pool ID, three named accounts (a self-signed-up student/CR, an admin-created faculty-role account, an admin account), and copy-pasteable `aws cognito-idp` commands to create more. This is infrastructure *for* testing (repeatable accounts with known state), not testing itself, but it's the reason the manual checklist in (a) is actually re-runnable rather than one-off.

### c. Ad-hoc Lambda invocation with synthetic identities
`docs/PLAN.md`'s verification section documents the actual practice: "invoke `section-changes` directly with synthetic identities, as done on Day 3" — checking that a CR of one course section can act for the whole course, that a non-CR is denied, that a CR of another batch is denied, that a forged section list is rejected. This is real security testing of the Cedar policy, and git history backs it up (`291ead4 Confirm through a Cedar policy in a Lambda` and the surrounding commits show the policy being iterated on) — but it happened as manual, one-off Lambda invocations during development, not as a committed, re-runnable test file. Nothing in the repo captures the actual synthetic-identity test cases that were run; the record of them is a line in a planning doc, not code.

### d. The finder's own self-check discipline
`docs/PLAN.md`'s verification section for the slot finder: "for a real IT Sem 5 course, check by hand that no returned slot overlaps any section's class, the professor's other classes, or an elective, and that a cancelled occurrence frees its hour." Manual, against real data, but real — this is the kind of check that actually validates the interval-intersection logic against ground truth the team could independently verify (they know the real IML timetable). Again: not automated, not committed as a test.

### e. TypeScript as the only automated gate
`docs/PLAN.md`'s "Build" verification step: `npx tsc -b` and the Amplify type check (`ampx sandbox`'s own schema type generation) must pass. This is real and automated — a broken schema or a type mismatch between a Lambda's return shape and a component's expectations fails the build — but it is a type-correctness check, not a behavior check. It would not catch, for example, the `find-slots` blocking-explanation logic returning the wrong section, or a Cedar policy silently permitting too much.

## 2. What a judge or interviewer would ask, and the honest answer

**"Do you have unit tests?"**
→ No. There is no automated test suite. What exists is a disciplined manual checklist (`docs/TESTING.md`) run against the live deployed app with known accounts and known expected data, plus ad-hoc synthetic-identity invocations of the authorization Lambda during development. TypeScript's compiler is the only thing that runs automatically and would fail a build.

**"How do you know the Cedar policy is actually correct, not just 'looks right'?"**
→ It was tested by direct Lambda invocation with synthetic identities representing each of the real cases the policy needs to get right: a CR acting within their course, a CR of a different batch trying to act (denied), a non-CR trying to act (denied), and a forged/expanded section list in the request being rejected because the server recomputes the affected sections from `TimetableSlot` rather than trusting the client (`section-changes/handler.ts`'s comment: "nothing here comes from the request itself"). Every decision — allow or deny — is also logged structurally to CloudWatch (`authorize()`'s `console.log(JSON.stringify({ cedar: decision, ... }))`), which is real evidence, visible on camera in the demo, that the policy engine actually ran and actually decided, not just that the code looks like it should.

**"How do you know the slot finder gives correct answers, not just plausible ones?"**
→ By hand, against real, independently-known timetable data — checking that a returned slot really doesn't overlap any affected section's real classes, the actual professor's real other classes, or a real elective. This is the strongest kind of manual test available given no formal test harness: the team could verify correctness because they had ground truth (the actual IIITA timetable) independent of the code. What it does *not* cover: edge cases the team didn't think to construct by hand — an empty-groups call, a course taught in one batch but queried against a different batch's sections, overlapping-but-not-identical DST-adjacent date boundaries (not applicable in IST but worth naming as a category), or the irregular-attendee grouping logic under enrollment data denser than what was ever actually uploaded.

**"What's your test coverage number?"**
→ Zero, literally — there's no coverage tool configured. The honest reframe: coverage as a percentage was never the target; targeted, ground-truth-verifiable manual checks against real data were, because for a four-day hackathon serving one real institute's real timetable, "does this match the actual PDF/spreadsheet a human can also read" is a stronger correctness signal than a synthetic unit test asserting behavior nobody has separately verified.

**"What would break in production that your testing wouldn't catch?"**
→ See the gap list below — concurrency and partial-failure paths in particular, since none of the manual testing (checklist or synthetic-identity invocation) exercises concurrent/racing requests, injected DynamoDB failures, or Cognito outages.

## 3. Honest gap list

1. **No automated tests at all** — no unit tests for `attendance.ts`'s pure functions (`homeOf`, `attended`, `heldFor`, `touches`), which is the single most test-friendly file in the codebase (pure functions over plain data, no AWS SDK calls, no I/O) and the one place a real `describe/it` suite would have been cheap to write and high-value, since it's the logic every other query depends on.
2. **No test for concurrent/racing writes** — the claim-CR race and the batch-write partial-failure path (`11_FAILURE_MODES.md` §1, #1 and #3) were never exercised; they were found by static code reading for this document, not by a test.
3. **No fuzz/property testing of the interval-intersection logic** — `find-slots/handler.ts`'s `candidates()` and `overlaps()` are exactly the kind of boundary-heavy logic (off-by-one on shared start/end times, `aS < bE && bS < aE` half-open interval semantics) that benefits from generated adjacent-boundary test cases; none exist. A single manual walk-through against one real course doesn't exercise the boundary cases systematically.
4. **No test of the ingestion reader against a corpus of known-bad sheets** — `parse-timetable/reader.ts`'s validation logic (merged-cell interpretation via L-T-P-S cross-checking) was validated against the specific real sheets the team had, not against a held-out set of malformed sheets designed to probe its limits.
5. **No load/concurrency testing** — nothing in the repo exercises what happens when multiple Lambda instances scan the same tables simultaneously, which is exactly the scenario that would surface the un-checked `UnprocessedItems` and the claim-CR race in practice rather than in theory.
6. **The manual checklist is a point-in-time artifact, not a regression gate** — nothing re-runs it automatically after a deploy; it depends on a human remembering to walk through 36 items, and its own "leave it clean for the demo" section (undo test changes, delete test enrollments) shows the team was aware that running it *pollutes* the very data it tests against, which is a sign the checklist and the production data were never properly separated (no dedicated test tenant/sandbox distinct from demo data).
7. **No test for the Cognito outage / `AdminGetUserCommand` failure path** (`11_FAILURE_MODES.md` #6) — this would currently take down every field in `section-changes`, untested.

## 4. What would be built first, with more time, to close this

In priority order, matched to actual risk:
1. A `describe/it` suite (Vitest, already implicitly available via the Vite toolchain — no new dependency) for `shared/attendance.ts`'s pure functions, since it's the cheapest, highest-leverage automated coverage available and the logic every dashboard, feed, and finder call depends on.
2. A synthetic-identity test file that captures the Day-3 ad-hoc Cedar checks as committed, re-runnable code instead of a line in a planning doc — this converts real, already-done verification work into a permanent regression gate for near-zero additional effort.
3. Boundary-case tests for `overlaps()`/`candidates()` (shared start/end times, zero-duration windows, a class exactly at the edge of the teaching day).
4. A CI step that actually runs whatever test suite results from (1)–(3), since today's `amplify.yml` has nowhere for tests to plug in even if they existed.
