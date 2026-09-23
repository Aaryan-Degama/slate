# 06 — The `find-slots` Lambda

## Status: real, deployed, not a stub [VERIFIED-REPO]

`amplify/functions/find-slots/handler.ts` (286 lines) is a fully implemented
interval-intersection engine, wired into the schema as a direct Lambda
resolver (`findSlots` query in `data/resource.ts`), reading five DynamoDB
tables (`TimetableSlot`, `ScheduleChange`, `StudentSection`, `RollRange`,
`Enrollment`) that `backend.ts` grants it read-only access to. `git log`
shows it landed early (`e0f4f06`/`e0e6ebd` area: "Slot finding as a Lambda:
ranked slots, reasons, room, blocking section") and was extended later for
professor-awareness and per-course logic (`0836fa4`-adjacent commits, and
`45ec2aa "Dated, course-wide changes and a professor-aware slot finder"`).
This matches CLAUDE.md §5's algorithm essentially line for line.

## The core idea: hard parties, soft parties, interval intersection

The problem: given a set of sections, a course (hence its professor), and a
list of candidate dates, find hours where **everyone who must attend** is
free, ranked sensibly, with a free room attached — and if nothing works, say
*whose* removal would fix it.

### Step 1 — build each "party's" busy set (`Party` type)

```ts
type Party = { name: string; kind: 'section' | 'professor' | 'students'; busy: Busy[]; students?: string[] }
```
A party is anything that must (or should) be free: a section, the course
professor, or a group of "irregular" students sharing an identical schedule.
Each party's `busy` array is built by `held()`:
```ts
const held = (keep: (r: Row) => boolean): Busy[] => [
  ...dates.flatMap((date) => slots.filter((r) =>
    r.day === weekdayOf(date) && r.id !== a.ignoreSlotId &&
    !offOn.has(`${r.id}|${date}`) && keep(r)
  ).map(...)),
  ...added.filter(keep).map(...),   // that date's EXTRA/MOVED_TO rows
]
```
This is the same "effective timetable" logic described in 05: regular
`TimetableSlot` rows for that weekday minus live cancellations
(`offOn`, built from `ScheduleChange` rows with `kind IN {CANCELLED,
MOVED_FROM}`) plus that date's additions (`EXTRA`/`MOVED_TO`).
`ignoreSlotId` exists specifically for the **Move** flow: the class being
moved shouldn't count as blocking its own new slot.

**Sections** (hard):
```ts
const parties: Party[] = groups.map((g) => ({
  name: label(g), kind: 'section',
  busy: held((r) => inBatch(r, g) && blocks(String(r.section), g.section)),
}))
```
`blocks()` implements the section/sub-section overlap rule from CLAUDE.md
§4: a B1 or B2 class occupies part of B; a B class occupies all of B1/B2; a
`'*'` row (a batch-wide elective) occupies everyone:
```ts
const blocks = (rowSection: string, g: string) =>
  rowSection === '*' || rowSection === g || rowSection === g[0] ||
  (g.length === 1 && rowSection[0] === g && rowSection.length === 2)
```

**Professors** (hard): a course can have a different professor per section
(the code comment cites IML in IT Sem 5 having three), so the professor set
is derived from the *actual* sections requested, not assumed:
```ts
const professors = a.courseId ? [...new Set(
  slots.filter((r) => r.courseId === a.courseId && r.faculty &&
    groups.some((g) => inBatch(r, g) && (r.section === g.section || blocks(String(r.section), g.section))))
    .map((r) => String(r.faculty))
)] : []
for (const prof of professors) parties.push({ name: prof, kind: 'professor', busy: held((r) => r.faculty === prof) })
```
Note `held((r) => r.faculty === prof)` has **no batch filter** — a professor's
busy set spans every batch they teach, matching CLAUDE.md §5 step 2 ("the
professor's regular classes and extras in any batch").

**Irregular attendees** (soft): students whose `Enrollment` exceptions put
them in this course with these sections but who aren't part of the requested
sections' baseline. Grouped by *identical effective timetable* (`slotIds`
joined and sorted as a map key) so 40 students with the same schedule collapse
to one `Party`, keeping the candidate-filtering loop cheap:
```ts
const key = [...att.slotIds].sort().join(',')
if (!profiles.has(key)) profiles.set(key, { name: '', kind: 'students', students: [], busy: held(...) })
profiles.get(key)!.students!.push(rollId)
```
These are explicitly **soft**: a clashing slot is still offered, just ranked
after clash-free ones, with the clashing students and what conflicts named
in the reason string. This matches the design rationale in CLAUDE.md §5.2a —
hard constraints for the actual attendee sets, soft for people whose
attendance is an exception, so one drop-year student's timetable can't
silently make the finder useless for the whole section.

### Step 2 — generate candidates, then intersect

```ts
function candidates(n: number, dates: string[], earliest: string, latest: string): Candidate[] {
  for (const date of dates) {
    if (day is SAT/SUN) continue
    for (let i = 0; i + n <= HOURS.length; i++) {
      // n consecutive, gap-free hours from the shared HOURS grid (src/lib/grid.ts)
      if (hours.some((h, k) => k > 0 && HOURS[h].start !== HOURS[h - 1].end)) continue
      ...
    }
  }
}
```
`HOURS` is imported from `src/lib/grid.ts` — the same fixed hour grid the
frontend timetable grid renders against, so "a free slot" always aligns to a
real displayable class period, not an arbitrary time. `n` is
`Math.max(1, Math.ceil(minDurationMins / 60))` — durations round up to whole
grid hours.

Free-for-a-party is pure interval overlap, checked per date:
```ts
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE
const freeFor = (c, pi) => !parties[pi].busy.some((b) => b.date === c.date && overlaps(c.start, c.end, b.start, b.end))
```
Hard parties (`all = parties.slice(0, hard)`) must all be free —
`common = cands.filter((c) => all.every((pi) => freeFor(c, pi)))`. This is a
plain O(candidates × hard-parties × busy-per-party) nested filter — no
interval trees, no sweep-line optimization, because the input sizes are tiny
(a handful of sections/professors, a couple weeks of candidate hours) and the
Lambda has a 30-second timeout to work with.

### Step 3 — rank

```ts
const rank = (c) => {
  let score = 0
  if (c.start >= '09:00' && c.end <= '17:30') score += 2   // within working hours
  if (!overlaps(c.start, c.end, '12:00', '14:30')) score += 2  // avoids lunch
  const edge = sectionIdx.filter((pi) => c.start < firstClassThatDay || c.end > lastClassThatDay)
  score -= edge.length   // "edge of someone's day" penalty
  return { score, reason: why.join(' · ') }
}
```
This is exactly CLAUDE.md §5 step 4: avoid lunch (12:00–14:30 here, vs the
brief's "12–2:30" — matches), stay within 9–5:30, penalize slots at the edge
of any section's day (meaning students would have to come in early/stay late
just for this one class). No ML, no learned weights — a small, fully
explainable additive score, with a human-readable `reason` string built
alongside the score rather than derived from it after the fact.

Final sort: `x.clashCount - y.clashCount || y.score - x.score || date || start` —
clash-free slots always outrank slots with irregular-student clashes,
regardless of score; only within the same clash count does the ranking score
decide.

### Step 4 — room suggestion

```ts
const allRooms = [...new Set(slots.filter((r) => r.room).map((r) => String(r.room)))]
const freeRoom = (c) => allRooms
  .filter((room) => !roomBusy.some((b) => b.room === room && overlaps(...)))
  .sort((x, y) => Number(labRooms.has(x)) - Number(labRooms.has(y))
                 || (lectureUse.get(y) ?? 0) - (lectureUse.get(x) ?? 0)
                 || x.localeCompare(y))[0] ?? null
```
Rooms come entirely from what's already printed in the ingested timetable
data (`allRooms` derived from `TimetableSlot.room`) — this directly answers
CLAUDE.md §6.2's stated precondition ("check whether room numbers are present
per slot; if not, drop the feature"): they are present, so the feature
shipped. The room ranking prefers rooms other lecture sections already use
over rooms only ever booked for labs (`labRooms`, from `sessionType === 'P'`)
— a room a practical class uses is more likely equipped/booked for labs
specifically and less suitable as a generic lecture-hour suggestion.

### Step 5 — the blocking explanation

When nothing survives the hard-party intersection, the code doesn't just say
"no slots" — it computes *which single hard party's absence* would unlock the
most candidate slots:
```ts
const options = all.map((pi) => ({ pi, opened: cands.filter((c) => all.every((o) => o === pi || freeFor(c, o))) }))
const best = options.sort((x, y) => y.opened.length - x.opened.length)[0]
```
This is a simple leave-one-out scan over the hard parties (sections +
professor) — for each, "how many slots would work if we ignored just this
one party's constraints?" — then reports the best (highest-unlock) option
with a concrete example date/time and what that party has then:
```ts
detail: who.kind === 'professor'
  ? `Every section is free ${n} time(s), but ${who.name} teaches then — e.g. ...`
  : `Without ${who.name}, ${n} slot(s) work for everyone else — e.g. ...`
```
This directly implements CLAUDE.md §5 step 5's "explainable interval
intersection and a bottleneck check" — no ML, a leave-one-out search over a
small candidate set, cheap because `hard` is at most a handful of parties.

## Observability: the CloudWatch line demo videos show

```ts
console.log(JSON.stringify({ event: 'slots-found', groups: a.groups, dates, courseId,
  professors, irregulars, hours: n, candidates: cands.length, common: ranked.length,
  blocking: blocking?.party ?? null }))
```
This structured log line is what CLAUDE.md §8's demo video plan points the
camera at (alongside the Cedar decision logs from `section-changes` — see
07) as the concrete, on-camera evidence that AWS compute (not a chatbot) is
doing the reasoning.

## What this Lambda deliberately does *not* do

- No ML/embedding-based matching anywhere — confirmed by the code: no vector
  search, no similarity scoring, just date/time string comparisons and set
  membership. This matches the cost-guardrail rule in CLAUDE.md §3 ("no
  embedding/vector search anywhere in this architecture").
- No persistence of results — every call recomputes from scratch via
  `scanAll()`, consistent with "effective timetable... computed, never
  stored" (see 05).
- No holiday/term-calendar awareness — `candidates()` only skips Saturday and
  Sunday; a public holiday inside the term isn't filtered out. `docs/PLAN.md`
  lists a semester calendar as **Phase 5, later** — an acknowledged, not
  hidden, gap.

---

## Q&A

**Q: Why scan whole tables instead of querying by section/date with a GSI?**
Because the actual query shape is "every section's, every professor's,
effective timetable across N candidate dates" — a query that touches most of
`TimetableSlot` and recent `ScheduleChange` rows anyway at this data
volume (a batch's worth of sections, a couple weeks of dates). A key-based
query would only pay off if the candidate/party set were large enough that
scanning cost noticeably more than a few targeted queries; `docs/DATA-MODEL.md`
proposes exactly this optimization (GSI `OFFERING#<id>`) for a future,
larger-scale redesign, but it isn't built or needed yet.

**Q: What's a "hard" vs "soft" party and why the distinction?**
Hard parties (the requested sections, the course professor) must be free for
a slot to be offered at all — they're not negotiable, everyone in them is
genuinely required at the class. Soft parties (irregular students via
`Enrollment` ADD exceptions) still get offered slots that clash with them,
ranked below clash-free ones, because they're a minority exception case —
if they were hard, one drop-year student with a bad schedule could make the
finder return nothing for an entire section's makeup class.

**Q: How does the finder handle a course taught by different professors per section?**
It derives the professor set directly from `TimetableSlot` rows matching
`courseId` **and** the requested sections (`groups.some(g => inBatch(r,g) &&
...)`) — not by looking up "the" professor for a course globally. If IML's
three professors each teach a different section, requesting only Sec C
pulls in only Sec C's professor as a hard constraint; requesting A+B+C would
pull in all three.

**Q: What does the blocking explanation actually compute, algorithmically?**
A leave-one-out search: for each hard party (each section, and the
professor), re-run the intersection pretending that one party had no
constraints, and count how many candidate slots that would open up. Report
whichever single party's removal opens the most slots, with a real example
date/time and what conflicting class they'd have then. It's O(hard parties ×
candidates), trivially cheap at this scale — not a general constraint solver.

**Q: Why is the reason string built inline in `rank()` rather than generated after scoring?**
So the human-readable explanation and the numeric score can never drift
apart — each rule (`within 9–5:30`, `avoids lunch`, `edge of day`) appends
both a score delta and its own reason fragment in the same `if`/`else`
branch, guaranteeing the shown reason always matches exactly why that slot
scored the way it did.
