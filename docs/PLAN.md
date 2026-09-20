# Slate: product replan (students · CRs · admin)

## Context

Slate started as a faculty tool, then pivoted mid-build (Day 3) to students-only with a class rep (CR) per section. The pivot was done piecemeal, so what exists doesn't yet add up to a product someone would use daily:
- Changes are **weekly**, so a cancellation repeats every week forever.
- A makeup class for Sec A+B+C needs **three CRs to re-add it**.
- **Find a Slot** is a section-picker that ignores the course, the professor's other classes, and cancellations.
- **Electives are silently dropped** at import (`parse-timetable/reader.ts` skips section-less elective rows), so the slot finder can propose slots that clash with them.
- Students have no way to notice that something changed.

This plan redefines what each person needs and sees, then orders the work so every phase leaves a working, deployable product. UI/visual design is out of scope; this is about flows, data and rules.

**Decisions already made (with the user):**
- It's a product beyond the hackathon; the submission ships whatever phases are done.
- A CR acts for **every section of the course in their batch**.
- Changes are **date-specific**.
- CR is **first to claim**; the admin can revoke.
- Electives come from **admin-uploaded registrations**.
- Notifications are an **in-app "What changed" feed**.
- **Professors don't log in**; their ingested schedule only feeds the slot finder.
- **Move/reschedule is one action**.

---

## Core concepts (the vocabulary every screen uses)

- **Batch**: program + branch + semester (e.g. B.Tech IT Sem 5). A CR's powers never leave their batch.
- **Section**: A, B, C… with sub-groups B1/B2 belonging to B. Students get theirs from their roll number, never by choosing it.
- **Regular class**: a weekly `TimetableSlot` row (ingested, read-only except admin corrections).
- **Occurrence**: a regular class on a specific date ("IML, Mon 22 Sep, 09:00").
- **Change** (dated): one of three kinds.
  - **Cancelled**: an occurrence called off.
  - **Extra**: a one-off class on a date.
  - **Moved**: a cancelled occurrence plus an extra class, linked together.

  Each change reaches the sections of that course **taught by the same professor** as the CR's section (IML in IT Sem 5 has a different professor per section; IVP's Prof. Vrijendra Singh teaches B2 and C), and records **who** (CR roll number and section) and **when**.
- **Effective timetable for a date** = that weekday's regular classes, minus cancellations on that date, plus extra classes on that date. Every view computes this; nothing else is stored.

---

## Who needs what, and what they see

### Student (everyone)
Needs: "What do I have today and this week, what changed, and who changed it?"
1. **My week**: **this week or next week**, nothing older or further out. It shows effective classes only.
   - Cancelled occurrences are struck through, with "Cancelled by IIT2024245 (CR, Sec C)".
   - Extra classes are marked "Extra, added by …".
   - Electives show only if the student is registered; if the batch has no registration data, the whole basket shows, labelled "elective (registration not uploaded)".
2. **What changed**: changes affecting me this week and next, newest first, with unseen ones highlighted (tracked by `User.changesSeenAt`, so it works across devices). No older history: changes expire via DynamoDB TTL (`expiresAt`) once their week is over.
3. **My section card**: section, current CR (roll number and since when), and **Become CR** if nobody holds it.
   **My Batch**: every section of the student's own batch, with its CR and roll numbers (or its roll range if no list is uploaded). Server-scoped to their batch via `batchRoster`; `StudentSection` is admin-only.
4. **Onboarding**: automatic. Section comes from the roll number (`StudentSection`, then `RollRange`). If it isn't found, "your roll number isn't in the uploaded lists; ask your admin". A student can still pick a section to *view*, but that pick is unverified and can never make them CR (the server already ignores it).

Students **don't** get Find a Slot; it's a CR tool. That removes a confusing screen.

### CR (a student who claimed their section)
Needs: "The professor told me X. Record it quickly and correctly for everyone in the batch."
Everything a student sees, plus one **Make a change** entry point with three actions:
1. **Cancel a class**: pick an upcoming occurrence from their own week, then confirm. The confirm screen lists every section it affects (e.g. "IML (L), Mon 22 Sep 09:00 · Sec A, B, C").
2. **Extra class**: pick a **course** from the batch; the sections its professor teaches are pre-selected, and the CR can deselect any.
   - Choose a week or dates, length and time window, then **find slots**. Each result is a *date* + time + free room + reason, ranked as today.
   - The finder avoids **every affected section's effective classes**, the **batch's electives**, and **the course professor's other classes in any batch**.
   - If no slot works, the blocking explanation can name a section *or* the professor ("Prof. X teaches CS301 to ECE then").
3. **Move a class**: pick an occurrence, then the same finder (for that course, excluding the original slot), then confirm. This creates one linked Moved change.
4. **My changes**: every change they made, each with **Undo**, which is kept in history as "undone by …".

### Admin
Needs: "Keep the data right and keep CRs accountable."
1. **Data**: upload timetables (as today), student lists (as today), and **course registrations** (new: roll → elective courses, same upload and review flow).
2. **Correct timetable** (exists).
3. **Class reps**: every section's CR, with Revoke (exists).
4. **Activity log** (new): every change across batches (who, what, when, undone?), filterable by batch.
5. *Later:* **Semester calendar**: term start/end and holidays, so weeks outside the term or on holidays show nothing.

---

## Rules (Cedar, `amplify/functions/section-changes/policy.cedar`)

- **ClaimCr**: principal's verified section == resource section, and the section has no CR. (Unchanged.)
- **Cancel / Move** an occurrence: the principal is the CR of a section in that class. **Extra**: the CR of a section the course's professor teaches. The resource carries `sections` (the set of CR-able section keys taking the course), and the policy checks `resource.crs.contains(principal)`.
- **Undo** a change: the CR who made it, or the current CR of any section it affects.
- **Admin**: everything.
- The server always recomputes the affected sections from `TimetableSlot` and never trusts a section list sent by the client.

---

## Data model changes (`amplify/data/resource.ts`)

- **ScheduleChange**, reshaped (one row per affected section keeps the per-section queries in `StudentDashboard` simple):
  - Add: `date` (YYYY-MM-DD, required for new rows), `groupId` (shared by all rows from one action), `kind` (`CANCELLED | EXTRA | MOVED_FROM | MOVED_TO`, replacing `changeType`), `faculty`, `changedBySection`.
  - Keep: `relatedSlotId` (the regular class a cancel/move refers to), `changedBy`, `undoneBy`, `undoneAt`.
  - Existing undated rows are ignored by all views; delete the one leftover test row.
- **TimetableSlot**: add `isElective`. Electives get stored instead of skipped: `section: '*'`, meaning the whole batch (`reader.ts` / `import-data`).
- **CourseRegistration** (exists, empty): filled by the new registration upload.
- **User**: add `changesSeenAt`.
- **ClassRep**: unchanged.
- Remove leftovers: `User.linkedFacultyName` and `Role.FACULTY` usage in the UI.

---

## Phased build (each phase deployable and demo-able on its own)

**Phase 0: align the brief (15 min).** Rewrite `CLAUDE.md` §1, §2, §4, §5, §8 to this product, so every session (and the teammate) builds the same thing.

**Phase 1: dated changes + course-wide actions (the core).**
- Schema: dated `ScheduleChange` and `groupId`.
- `section-changes/handler.ts`:
  - `cancelOccurrence(slotId, date)` and `addExtra(courseId, sections, date, start, end, room)`. The server derives the batch's sections for the course and checks the CR.
  - `undoChange` works per group.
  - Update the Cedar policy.
- `src/lib/grid.ts`: `buildGrid` takes a week start date and returns the effective timetable. The existing `cancels()` matching extends to match on `date`.
- `StudentDashboard.tsx`: week navigation, and CR actions for Cancel and Extra. The existing free-cell / class-click entry points stay but carry the date.

**Phase 2: course-driven, professor-aware finder + Move.**
- `find-slots/handler.ts`: new `courseId` + `dates` inputs.
  - Busy set = sections' effective classes on each date (subtract cancellations, add extras), plus batch electives, plus the professor's classes and extras in all batches.
  - The blocking explanation also considers the professor.
  - Reuse `candidates()`, `freeRoom()`, `rank()` and the blocking logic as they are.
- `NewRequest.tsx` becomes **Extra class / Move** for CRs only: course picker → sections pre-selected → dates → results.
- Add the `moveOccurrence` mutation (one group: MOVED_FROM + MOVED_TO).

**Phase 3: What changed + activity log.**
- Student feed: filter `ScheduleChange` by section and date ≥ today, with `changesSeenAt`.
- CR "My changes" list: extend the existing change-history list in `StudentDashboard.tsx`.
- Admin Activity log: new `AdminActivity.tsx` following the `AdminClassReps.tsx` pattern.

**Phase 4: electives.**
- Stop skipping electives in `reader.ts`; store them batch-wide with `isElective`.
- Registration upload (`import-data`, new `kind: 'registrations'`, mirroring `students.ts` and `StudentImport.tsx`).
- Student view filters electives by registration.
- The finder treats batch electives as busy.

**Phase 5 (later):** semester calendar/holidays, SES email digest, a read-only professor view.

---

## Reused as-is
- `resolveSectionFromEmail` (`src/lib/rollLookup.ts`) and its server twin `sectionOf` (`section-changes/handler.ts`).
- Slot ranking, rooms and blocking explanation (`find-slots/handler.ts`).
- Grid lanes and merging (`TimetableGrid.tsx`, `mergeSameClass` in `grid.ts`).
- Admin upload/review flow (`AdminUpload.tsx`, `import-data`).
- `listAll`, `useClassReps`, `personLabel`.
- Backend deploys must use the proxy: `NODE_OPTIONS="--require $PWD/scripts/force-proxy.cjs" … npx ampx sandbox --once`.

## Verification (per phase)
- **Lambda rules:** invoke `section-changes` directly with synthetic identities, as done on Day 3.
  - Allowed: CR of any course section cancels/adds for the whole course; claimer of an empty section.
  - Denied: a non-CR; a CR of another batch; a CR acting on a course their section doesn't take; a forged section list.
  - Clean up test rows afterwards.
- **Finder:** for a real IT Sem 5 course, check by hand that no returned slot overlaps any section's class, the professor's other classes, or an elective, and that a cancelled occurrence frees its hour.
- **Live app:** sign in as a Sec C student and claim CR.
  - Cancel IML next Monday: every IML section sees it struck through with the CR's roll number, the feed shows it, and next week is unaffected.
  - Move it: the linked pair appears.
  - Undo it: it's struck through in the history.
- **Admin:** revoke the CR, then another student can claim; the activity log lists everything.
- **Build:** `npx tsc -b` and the ampx type check pass; frontend deployed with `scripts/deploy-frontend.sh`.
