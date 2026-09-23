# 05 — Data Model & DynamoDB

## Two data models exist in this repo — know which is real [VERIFIED-REPO]

There are two documents describing Slate's data model: `CLAUDE.md` §4 (the
one actually implemented, confirmed against `amplify/data/resource.ts`) and
`docs/DATA-MODEL.md` (a *proposed* registration-driven redesign —
`Course`/`Offering`/`ClassMeeting`/`Registration` — that is **not** built.
`git log` shows the commit `0836fa4 "Plan a registration-driven data model"`
added `docs/DATA-MODEL.md` as a planning document; no commit after it touches
`amplify/data/resource.ts` to add those models. This file describes the
**real, deployed** model. If asked about `Offering`/`Registration` in an
interview: "that's a documented redesign for the ADD/DROP `Enrollment`
exceptions model's real limitations, not shipped."

## The real schema (`amplify/data/resource.ts`)

```ts
User            { email, role, linkedSection: a.json(), changesSeenAt }
TimetableSlot   { program, branch, section, semester, day, startTime, endTime,
                  courseId, room, faculty, sessionType, isElective }
ScheduleChange  { groupId, kind, date, program, branch, semester, section,
                  startTime, endTime, courseId, sessionType, room, faculty,
                  relatedSlotId, changedBy, changedBySub, changedBySection,
                  undoneBy, undoneAt }
ClassRep        { sectionKey, program, branch, semester, section, sub, email }
RollRange       { admissionYear, program, branch, semester, minRoll, maxRoll, section }
StudentSection  { admissionYear, rollNumber, rollPrefix, name, program, branch,
                  semester, section, subSection }
Enrollment      { rollId, courseId, action (ADD|DROP), program, branch, semester, section }
```

Every `a.model()` in Amplify Gen 2 becomes **one DynamoDB table**, with a
generated `id` primary key (a `randomUUID()` string in the Lambda-written
rows, e.g. `section-changes/handler.ts`'s `newRow()`). This is Amplify's
default: **multi-table, one table per model** — not the single-table design
pattern DynamoDB experts often reach for.

## Why multi-table here, not single-table

Single-table design (one table, composite `PK`/`SK`, many item "types"
sharing it) earns its complexity when an app needs to fetch heterogeneous
related items in one query (e.g. "an order and all its line items") or is at
a scale where minimizing round trips matters. Slate's actual access pattern,
confirmed by reading the Lambda code, is almost entirely **table-wide scans**:

```ts
// find-slots/handler.ts
const [slots, changes, students, ranges, enrollments] =
  await Promise.all([scanAll(TT), scanAll(SC), scanAll(SS), scanAll(RR), scanAll(EN)])
```
`scanAll` (defined identically in `find-slots/handler.ts`,
`section-changes/handler.ts`, and `import-data/handler.ts`) pages through an
entire table with `ScanCommand` + `ExclusiveStartKey`. The slot finder needs
*every* `TimetableSlot` row and *every* live `ScheduleChange` to build
per-section busy sets across arbitrary sections and dates — there's no key
design that avoids the scan when the query is "all classes for these N
sections, on these M dates, adjusted by whichever changes happen to apply."
Single-table design buys locality for *known* access patterns; Slate's slot
finder pattern is closer to "load everything, filter in memory," so paying
the schema complexity of single-table design (careful GSI overloading, entity
type prefixes) would buy nothing here — this is a case where the "boring"
multi-model default is the right call, not a shortcut.

`docs/DATA-MODEL.md`'s proposed redesign explicitly names this cost ("All
reads today are table scans, which is fine at 3,000 students but wasteful")
and sketches real keyed access patterns (`PK STUDENT#<rollId>`, GSI `PK
OFFERING#<offeringId>`) for a registration-driven model — that's the
single-table thinking the current shipped model deliberately deferred, given
the dataset size (~3,000 students, a handful of course sections) makes table
scans cheap enough in practice for a hackathon-scale deployment.

## `ScheduleChange`: the one row-per-affected-section design, and why

A single "cancel IML for sections A, B, C on 22 Sep" produces **three**
`ScheduleChange` rows, one per section, sharing a `groupId`:

```ts
// section-changes/handler.ts
const cancelRows = (ctx, groupId, kind, date, together) =>
  together.map((r) => newRow(ctx, groupId, { kind, date, program: r.program, ...,
    section: r.section, relatedSlotId: r.id }))
```

This denormalizes what could have been one row with a `sections: string[]`
array. The reason is query shape: `StudentDashboard` needs "changes that
affect *my* section" — with one row per section, that's a straight filter
(`c.section === mine.section`) over a scanned table; with an array field,
every reader would need to check array membership instead of equality, and a
per-section `undo` (a CR undoing a change only for their own section — see
07) becomes impossible to express as a targeted `UpdateCommand` on a single
row, since one row would be shared state across sections with different
undo history. `groupId` keeps the rows that came from one CR action
linkable for the "undo the whole thing" case.

`kind` is `a.enum(['CANCELLED', 'EXTRA', 'MOVED_FROM', 'MOVED_TO'])` — a move
is modeled as two linked rows (a cancellation of the old slot + an extra at
the new time), not a first-class "moved" concept, so every downstream reader
(the grid, the "what changed" feed) only ever needs to understand cancel and
extra semantics, never a third case.

## TTL: the whole "only this week and next" feature is a DynamoDB setting

```ts
// backend.ts
backend.data.resources.cfnResources.amplifyDynamoDbTables['ScheduleChange']
  .timeToLiveAttribute = { attributeName: 'expiresAt', enabled: true };
```
```ts
// section-changes/handler.ts
const expiresAt = (date: string) =>
  Math.floor(new Date(`${addDays(mondayOf(date), 7)}T00:00:00+05:30`).getTime() / 1000)
```
Every `ScheduleChange` row is written with `expiresAt`: the epoch-seconds
timestamp of the Monday *after* the change's week. DynamoDB's TTL mechanism
scans for expired items in the background and deletes them at no write-capacity
cost, usually within 48 hours of expiry (it's best-effort, not instant).
This means the product requirement "changes only show for this week and
next, no older history" (CLAUDE.md §2) needs **zero application code** for
cleanup — no scheduled Lambda, no manual purge job. The tradeoff: TTL
deletion isn't immediate or guaranteed-exact, so a stale row can briefly
outlive its week; every reader (`find-slots`, `section-changes`'s own
`assertNotCancelled`) already filters on `date`/`undoneAt` anyway, so a
slightly-late TTL delete never produces a wrong answer, only a harmless
delay before the row physically disappears.

## The "effective timetable" is computed, never stored

There is no `EffectiveClass` table or materialized view. "What does section C
have on 22 Sep" is answered at read time by combining three sources:
1. `TimetableSlot` rows for that weekday, filtered by section.
2. `ScheduleChange` rows with `kind IN (CANCELLED, MOVED_FROM)` for that date
   → subtract (via `relatedSlotId`).
3. `ScheduleChange` rows with `kind IN (EXTRA, MOVED_TO)` for that date → add.

`find-slots/handler.ts`'s `held()` helper is the canonical implementation:
```ts
const held = (keep: (r: Row) => boolean): Busy[] => [
  ...dates.flatMap((date) => slots.filter((r) =>
    r.day === weekdayOf(date) && !offOn.has(`${r.id}|${date}`) && keep(r)
  ).map(...)),
  ...added.filter(keep).map(...),
]
```
where `offOn` is the set of `slotId|date` pairs a live cancellation/move
points at. This design means correcting a cancellation (undo) or re-ingesting
a corrected timetable never requires touching or recomputing any derived
row elsewhere — there's nothing derived to go stale. The cost is that every
read (student week view, slot finder) does this reconstruction on the fly;
acceptable because the inputs (`TimetableSlot` + a couple weeks of
`ScheduleChange`) are small enough to hold in Lambda memory after a scan.

## `RollRange` vs `StudentSection`: two sources of truth for "which section"

`homeOf()` in `amplify/functions/shared/attendance.ts` resolves a roll number
to a section by checking `StudentSection` (an admin-uploaded, per-student
list — precise, has names, sub-sections) first, falling back to `RollRange`
(a coarser "IIT2024001–IIT2024060 = Sec A" range, printed directly under the
timetable grid in the source spreadsheets, extracted by
`parse-timetable/reader.ts`'s `readRollRanges()`). This two-tier fallback
exists because student lists aren't uploaded for every batch/semester at
once — a batch with only a timetable (which usually prints roll ranges
alongside the grid) can still resolve sections without waiting on a separate
student-list upload.

```ts
// shared/attendance.ts
export function homeOf(value: string, students: Row[], ranges: Row[]): Home | null {
  ...
  const student = students.filter((r) => ok(r) && Number(r.rollNumber) === p.roll)
    .sort((a, b) => Number(b.semester) - Number(a.semester))[0]
  if (student) { ... return precise section+subSection ... }
  // fall back to RollRange
  const hits = ranges.filter((r) => inBranch(r) && p.roll >= r.minRoll && p.roll <= r.maxRoll)
  ...
}
```

## `Enrollment`: exceptions, not the base model

The shipped model's default assumption is "you attend your home section's
classes." `Enrollment` rows are *exceptions* only: `DROP` removes a course
from a student's home-section attendance; `ADD` attaches them to a specific
`(courseId, program, branch, semester, section)` group elsewhere — a
drop-year/backlog student taking a course with a different batch's section,
or an elective pick (`section: '*'`). Until a student has *any* elective
`ADD`, `attended()` in `shared/attendance.ts` shows them **every** elective in
their batch, flagged `electivesUnconfirmed: true` — an honest "we don't know
which elective you're actually in yet" rather than guessing or hiding data.

This is the exact limitation `docs/DATA-MODEL.md` is written against: a
sparse ADD/DROP-exceptions table doesn't scale cleanly to minors, open
electives and shared cross-programme courses, hence the unbuilt
`Course`/`Offering`/`Registration` proposal — but that's future work, not
what's running.

## Authorization at the schema layer

Every model's `.authorization()` chain is Cognito-userPool-backed:
- `TimetableSlot`, `RollRange`: `allow.authenticated().to(['read'])`,
  `allow.group('ADMIN')` for write — ingested data, publicly readable to any
  signed-in user, only admin-writable.
- `StudentSection`, `Enrollment`: `allow.group('ADMIN')` only, full stop — these
  carry personal data (names, roll-to-section mapping) that should never be
  scanned by a student client directly; students only see derived,
  batch-scoped slices of it through the `mySection`/`batchRoster` Lambda
  resolvers, which apply their own scoping logic server-side.
- `ScheduleChange`: `allow.authenticated().to(['read'])` — all writes go
  exclusively through the `sectionChanges` Lambda's custom mutations, which
  is where Cedar decides (see 07); the model itself grants no direct write
  path for any principal, including admins — an admin's write also goes
  through `section-changes`, whose Cedar policy has a catch-all admin rule.
- `ClassRep`: read for everyone, `allow.group('ADMIN').to(['read', 'delete'])`
  for the admin's revoke button; claiming a CR seat goes through the
  Lambda-backed `claimCr` mutation, not a direct model write.

---

## Q&A

**Q: Why one DynamoDB table per model instead of single-table design?**
Single-table design pays off when access patterns are keyed and you want to
minimize round trips for related-item fetches. Slate's real hot path is
scan-everything-then-filter-in-memory (the slot finder needs every timetable
slot and every live change across arbitrary sections/dates) — there's no key
design that avoids that scan, so the schema complexity single-table design
would add buys nothing at this data volume (~3,000 students). Amplify Gen 2's
default of one table per `.model()` is the right, boring choice here.

**Q: How is "this week and next only" enforced without a cron job?**
DynamoDB TTL on `ScheduleChange.expiresAt`, set at write time to the Monday
after the change's week. AWS deletes expired items in the background at no
extra write-capacity cost — no Lambda, no scheduled cleanup, and every
reader already filters on date/undo state so a slightly-late TTL delete
(TTL is best-effort, not instant) never produces an incorrect answer.

**Q: Why store a `ScheduleChange` row per affected section instead of one row with a `sections` array?**
Because reads need "changes affecting my section" as an equality filter, and
undo needs to target a single section's rows independently of others in the
same action (a CR can undo a change just for their own section). A shared
array field would make both harder: array-membership filtering on every
read, and no way to mark "undone for section C only" on a shared row.
`groupId` still links the rows from one action for whole-group undo.

**Q: Is the `Offering`/`Registration` model in `docs/DATA-MODEL.md` implemented?**
No — confirmed by diffing `amplify/data/resource.ts` against that document
and checking `git log` for any commit touching the schema after
`0836fa4` (which added the planning doc). It's a documented future
redesign addressing real limits of the shipped `Enrollment` ADD/DROP model
(electives, minors, cross-programme courses), not shipped code.

**Q: Why does `Enrollment` default to "attend your home section," with exceptions, instead of registrations being the source of truth?**
Because the real ingested data at build time was timetables + student
section lists, not registration data — registrations (who's actually
enrolled in what) weren't available, so the model had to default to the
best inference available (home section) and layer real exceptions on top
as they're admin-uploaded. This is precisely the tradeoff `docs/DATA-MODEL.md`
argues should be inverted once registration data (the mid-sem examinee
list) is available.
