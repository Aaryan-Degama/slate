# Slate — project brief for Claude Code

## 0. Context

This is a hackathon submission: **First Commit** (WeMakeDevs × AWS), Sept 17–20, 2026. Four days.

Hard rules from the organisers that constrain everything below:

- The repo must be **new**. No code written before Sept 17. Git history is checked against event dates; a mismatch disqualifies the team.
- The project **must use AWS**, and the **demo video must show AWS in use**. Naming it in the writeup is not enough.
- Submission = public repo + demo video (max 3 min) + short writeup (problem, build, where AWS fits).
- Judges score **only the submission**. No live demo, no call. A feature that isn't in the video does not exist.
- Judging criteria: idea/impact, built on AWS, what we learned, execution (does it actually run), demo video.
- Track: **Ship It** — deployed on AWS with a public URL. Architecture and cost decisions are part of the score. **Best UI** is a separate ₹1,00,000 prize open to a project from either track.
- Stated theme: "Build something that solves a real problem: one you deal with yourself, one the people around you face every day, or a clunky way of doing things nobody has bothered to fix yet."
- Open-source libraries, boilerplate and starter templates are allowed. What's judged is what we added during the event. Everything borrowed gets credited.

**Therefore: one working vertical slice beats five half-features. Always.**

### Why this idea, and why it's this narrow

We went through two prior versions before this one: a campus lost & found app (two-sided, abandoned — every dataset we checked shows this category fails to get adopted, including a dead attempt at IIITA itself), and a broader "curriculum + timetable + free-slot" tool (good direction, too much surface area). This is the distilled version: **one feature, done properly**, chosen because it's the one part of the broader idea with no prior art anywhere we looked, the sharpest "why isn't this just an LLM" answer of anything considered, and it needs no second user to already exist — the sections it coordinates are real, pre-existing enrollment groups, not a community anyone has to build.

---

## 1. The problem, precisely

At IIIT Allahabad, timetable changes (a cancelled lecture, a makeup class, a class moved to another day) are agreed between a professor and the class representative (CR), then spread by WhatsApp. Students miss them, and when a makeup class spans several sections, finding one hour where none of them clash (and the professor is free) takes a day of polls and back-and-forth. The information needed to answer it instantly already exists, scattered across separate timetables nobody has cross-referenced.

---

## 2. What we are building

> **Revision note (Day 3 → 4):** the product went from faculty-driven (a professor schedules, students see it) to **student-run, with one CR per section**. That's how changes really happen here: the professor tells the CR, the CR tells everyone. Professors don't log in; their ingested schedule only feeds the slot finder. The full reasoning and phased build plan are in `docs/PLAN.md`.

### Core concepts

- **Batch**: program + branch + semester (B.Tech IT Sem 5). A CR's powers never leave their batch.
- **Section**: A, B, C, with sub-groups B1/B2 belonging to B. A student's section comes from their roll number (admin-uploaded student lists / roll ranges), never from their own choice.
- **Regular class**: a weekly `TimetableSlot` row, ingested, read-only except admin corrections.
- **Occurrence**: a regular class on a specific date.
- **Who attends a class**: a student attends their home section's classes, adjusted by their `Enrollment` exceptions (ADD a course with another section/batch, DROP one, or pick an elective). With no exceptions uploaded, that's exactly their section's timetable.
- **Change** (always dated): **Cancelled** (an occurrence called off), **Extra** (a one-off class), or **Moved** (a linked cancel + extra). A change reaches the sections of that course taught by the same professor as the CR's section (a course can have a different professor per section: IML in IT Sem 5 has three), and records who made it (CR roll number and section) and when. Undo keeps the record, marked "undone by …".
- **Effective timetable** for a date = regular classes that weekday − cancellations that date + extras that date. Computed, never stored.

### Who sees what

**Student:** **this week and next week only** (no older history); cancelled occurrences struck through and extras marked, each with who made it; one "What changed this week and next" list (new ones highlighted until marked seen); their section card showing the current CR, or **Become CR** if there's none; **My Batch**: every section of their own batch (never another batch) with its CR and roll numbers (served by the `batchRoster` query; the student list itself is admin-only). Electives show only if registered (admin upload); without registration data the whole basket shows, labelled as such.

**CR** (a student who claimed their section; first to claim, admin can revoke): everything a student sees, plus **Make a change**:
- **Cancel** an occurrence.
- **Extra class**: pick a course; the sections its professor teaches are pre-selected; the finder returns dated slots free for every affected section, the batch's electives, and the course professor (in any batch), with a free room and reasons, or explains who blocks it.
- **Move**: an occurrence to a finder-chosen slot.
- **My changes**, each with Undo.

**Admin:** upload timetables, student lists and course registrations; correct timetable data; list and revoke CRs; an activity log of every change across batches for this week and next.

### Non-goals — do NOT build these

Voting or approval flows between students/CRs (one CR decides for the course; others can undo for their own section). Chat/messaging. Professor logins (for now). Recurring changes (every change is one date). Crowdsourced edits to regular timetable data (admin only). User-created groups. A native mobile app. Multi-institution support (IIITA is hardcoded). Visual/UI design work until the flows are done. Anything not above: ask first.

---

## 3. Architecture

Ship It track. Deployed, with a public URL, from day one.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite, TypeScript | Typed client from the Amplify Gen 2 schema |
| Hosting | AWS Amplify Hosting | Public URL in minutes, CI from GitHub |
| Auth | Amazon Cognito, IIITA email domain gate, `ADMIN` group | The domain gate is the closed-community boundary. Everyone else is a student; a student becomes CR by claiming their section (a `ClassRep` row), not through a Cognito role |
| API + DB | Amplify Gen 2 data (AppSync + DynamoDB) | Generated from a schema file, no hand-written CRUD |
| Data ingestion | Admin uploads the official timetable / student-list spreadsheets → S3 → `parse-timetable` Lambda reads them into rows + validation issues → admin reviews → `import-data` Lambda writes DynamoDB | Runs per semester from the app, not a script. The real sheets are inconsistent across programs (merged cells, cohort labels, sub-sections); the reader handles those and flags what it can't read. Textract/Bedrock on PDFs was the original plan; `scripts/bedrock-normalize-timetable.py` exists but isn't in the live path |
| Slot-finding logic | `find-slots` Lambda: interval intersection across every affected section's effective timetable plus the course professor's, constraint filtering, simple ranking, a free-room pass, and a blocking explanation when nothing fits (§5) | Needs every affected section's and the professor's timetable at once; no chatbot has that data |
| Authorization | Cedar (`cedar-wasm` inside the `section-changes` Lambda) | Real policy file (`policy.cedar`): claim CR only for your own verified section while it has none; only a course section's CR changes that course in their batch; admins can do anything. Every decision is logged to CloudWatch |
| Notification | In-app "What changed" feed (SES dropped) | Every change is a dated `ScheduleChange` row that the affected students' week view and feed pick up, with who made it |
| Logs | CloudWatch | The Cedar allow/deny decisions from `section-changes` and the `slots-found` line from `find-slots`, shown on camera |

### The honest call on ingestion — say this in the writeup, don't hide it

Fully automated PDF ingestion is a real risk — accuracy on inconsistent institutional formatting is unknown until tested. The plan: **run Textract + Bedrock for real on actual AAA timetable PDFs and show it working on camera** — that is the genuine AWS story. If ingestion accuracy is too low to trust for the demo on some programs, hand-structure those from the same real PDFs rather than fabricating data. Say plainly in the writeup which parts were automated and which were hand-verified.

### Cost guardrails

No OpenSearch, RDS, NAT Gateway, ECS/Fargate, EKS, or EC2. Everything scales to zero when idle. No embedding/vector search anywhere in this architecture — there's no matching-by-similarity problem here, just structured data and interval math.

---

## 4. Data model

```
User            owner, email, role (STUDENT|ADMIN, display only; ADMIN
                rights come from the Cognito ADMIN group), linkedSection,
                changesSeenAt
TimetableSlot   program, branch, semester, section ('*' = whole batch:
                an elective basket, or a class the sheet labels "All"),
                day, startTime, endTime, courseId, room, faculty,
                sessionType (L/P/T), isElective
StudentSection  admissionYear, rollNumber, program, branch, semester,
                section, subSection         -- admin-uploaded student lists
RollRange       admissionYear, program, branch, semester, minRoll,
                maxRoll, section            -- fallback roll -> section
Enrollment      rollId ("IIT2023045"), courseId, action ADD|DROP,
                program, branch, semester, section  -- exceptions to
                "you attend your home section's classes": a course taken
                with another section/batch (drop-year, backlog), a course
                not taken, or an elective choice (section '*')
ClassRep        sectionKey ("program|branch|semester|section"), program,
                branch, semester, section, sub, email
ScheduleChange  one row per affected section:
                groupId (shared by one action), kind (CANCELLED | EXTRA |
                MOVED_FROM | MOVED_TO), date (YYYY-MM-DD), program, branch,
                semester, section, startTime, endTime, courseId, room,
                faculty, relatedSlotId, changedBy, changedBySection,
                undoneBy, undoneAt, expiresAt (TTL: deleted the Monday
                after its week -- only this week and next are ever shown)
```

All writes to `ScheduleChange` and `ClassRep` go through the `section-changes` Lambda, where the Cedar policy (`amplify/functions/section-changes/policy.cedar`) decides. The server derives a caller's section from their verified email and a course's sections from `TimetableSlot`; it never trusts sections sent by the client.

---

## 5. The slot-finding algorithm

Input: a course in the CR's batch, the sections taking it (pre-selected, deselectable), candidate dates, and constraints (time window, length).

1. For each candidate date, build each section's effective busy set: regular classes that weekday, minus cancellations that date, plus extras that date, plus the batch's electives (treated as busy, conservatively).
2. Add the course professor's busy set: their regular classes and extras in **any** batch. Sections and the professor are **hard**: a slot must be free for all of them.
2a. Add every *irregular* attendee (a student whose `Enrollment` exceptions make their timetable differ, e.g. a drop-year student taking this course with these sections), grouped by identical timetables so the work stays small. These are **soft**: slots that clash are still offered, ranked last, naming who clashes and with what.
3. Intersect free intervals across all of them; filter by the constraints.
4. Rank: avoids lunch (12–2:30), within 9–5:30, not at the edge of anyone's day. Attach a free room.
5. If nothing survives: report the single section, or the professor, whose removal unblocks the most slots, and what they have then.

No ML: explainable interval intersection and a bottleneck check, in its own Lambda (`find-slots`).

---

## 6. Two things to confirm before building further

1. **This actually happens.** Ask two classmates or a CR: has scheduling a makeup/extra class across sections been a real, recurring headache — not a one-off you happened to notice.
2. **Room data exists in the real timetables.** Pull one actual AAA timetable PDF and check whether room numbers are present per slot. If not, drop the room-suggestion feature rather than fabricate it.

---

## 7. Build order

**Day 1 (remainder of today)**
- Repo init, first commit, push. Clone the Amplify Vite/React template.
- Cognito with the IIITA domain gate and the `role` attribute. Deploy. Public URL exists by end of day.
- Pull 2–3 real AAA timetable PDFs. Run the Textract/Bedrock gate test — this decides whether ingestion is automated or hand-structured for the demo.
- Do the two confirmations in §6.
- Hand-structure real timetable data for at least a few sections as a reliable fallback regardless of the gate test result.

**Day 2**
- `TimetableSlot` schema live with real data (ingested or hand-structured).
- Slot-finding Lambda: core interval intersection + constraint filtering. Test it by hand against real timetables you can verify yourself.

**Day 3**
- Room-suggestion pass and the blocking-section explanation.
- `New Request` and `Proposed Slots` screens wired to the Lambda.
- `Confirm` screen, Cedar role gate, `ScheduleChange` write wired and reflected live on the Student/Teacher dashboard grids, tested for real.

**Day 4**
- UI polish — Best UI is a separate ₹1,00,000 prize and most teams ship unstyled forms.
- Record the video. Write the writeup, including the ingestion honesty point from §3.
- **Submit by midday, then keep editing until the deadline.**

---

## 8. Demo video — 3 minutes, one thread

1. **0:00–0:25** The problem: the professor tells the CR "IML makeup this week for A, B and C"; the WhatsApp poll starts; half the class misses the update.
2. **0:25–0:50** A student's week: date-based, their section's CR shown. Show AWS: the Cognito sign-in and the admin upload (S3 + Lambda parse).
3. **0:50–1:40** The CR: Extra class → pick IML → sections pre-selected → dated slots that avoid every section, the electives and the professor, with a room and reasons. Then the no-slot case with the blocking explanation naming who blocks it.
4. **1:40–2:10** Confirm, then cut to a Sec A student: the extra class appears with the CR's roll number, and it's in their "What changed" feed. A non-CR trying the same is denied: show the Cedar deny line in CloudWatch.
5. **2:10–2:35** Architecture diagram and the live URL.
6. **2:35–3:00** What we learned: ingesting real institutional timetables, and why the CR model (not faculty logins) fits how changes actually happen.

---

## 9. Repo hygiene

- First commit after the event opens. Commit and push frequently — the history is the proof the project is new.
- `README.md`: problem, stack, architecture diagram, live URL, how to run.
- `CREDITS.md`: the Amplify starter template (MIT-0), any referenced repos, every open-source library, and **every AI coding tool used** — required by the rules.
- `LICENSE`.
- Never commit AWS keys. Amplify handles credentials; nothing goes in the repo.

---

## 10. Working agreement for Claude Code

- Ask before adding any dependency or any AWS service not listed in §3.
- Ask before adding any feature not in §2 — especially a student planner screen, a voting/poll flow, or recurring requests. Those were deliberately cut; re-adding them is the main way this project balloons back to something unfinishable in three days.
- Prefer the smallest thing that runs end to end over the correct thing that isn't wired up yet.
- After every feature: deploy it, confirm it works on the live URL, commit, push.
- When something is genuinely broken, say so plainly. Do not stub a function and describe it as working — the video will expose it.
- Explain the AWS pieces as you build them. Learning is a scored criterion, and §8 point 6 needs real specifics, not generic ones.
