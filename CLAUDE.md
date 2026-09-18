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

At IIIT Allahabad, when a professor needs to schedule a makeup class, a doubt session, or an extra lecture for a course that spans multiple branches or sections, there is no way to see everyone's timetable at once. Today this means a WhatsApp poll to two or three CRs, or an email thread going back and forth for a day or two, trying to find one hour where none of the affected sections clash. It happens often, it always costs real time, and the information needed to answer it instantly already exists — it's just scattered across separate timetables nobody has cross-referenced.

---

## 2. What we are building

> **Revision note (Day 2):** the scope below was expanded from the original 3-screen, faculty-only plan after building the first version and testing it against real data. The original plan (faculty picks sections → sees free slots → emails CRs) is preserved as the core scheduling flow. Added: a student dashboard and a teacher dashboard, both read-only views of the same ingested timetable data with no new data entry beyond a one-time identity link; and the confirm step now updates the visible timetable grid directly instead of sending an SES email. See git history around this revision for what changed and why — the reasoning (especially around not fabricating per-student elective data) is preserved in `NOTES.md` (untracked, local).

**Five screens**, all reading from the same ingested timetable data. Two are the original scheduling flow; two are read-only dashboards; the fifth is a lightweight one-time identity link.

### The screens

1. **New Request** (faculty) — select the program/branch/section combinations that must attend, plus optional constraints (earliest/latest time, which days are allowed, how long the slot needs to be).
2. **Proposed Slots** (faculty) — a visual weekly grid (days × real class hours) with genuinely free slots highlighted green, plus the same reasoning as before ("free for all 3 sections, mid-morning, no lunch clash") and a suggested room. If no slot satisfies every constraint, show which section is the actual blocker instead of just failing silently.
3. **Confirm** (faculty) — requester picks the winning slot. No email. Instead, this writes a `ScheduleChange` record that the affected sections'/faculty's grid views pick up and highlight — green for newly scheduled, a distinct color for cancelled. One-directional. Not a chat, not a poll — the decision is already made, this just makes it visible to whoever looks at their timetable.
4. **Student Dashboard** — after a one-time identity link (self-select their real section from the ingested list — see §4a), shows their own weekly timetable as a grid, generated entirely from ingested `TimetableSlot` data plus any `ScheduleChange` highlights for their section. Also lets them check which slots are free for their own class (read-only — a student never schedules anything).
5. **Teacher Dashboard** — after a one-time identity link (self-select their real name from the ingested faculty list), shows their own teaching timetable as a grid, generated from ingested data (which sections they teach, when, where) plus `ScheduleChange` highlights.

### Non-goals — do NOT build these

Any voting or back-and-forth confirmation among students — the requester decides, the tool informs. Editable or crowdsourced timetable *course* data — it's read-only, ingested from official sources; the only self-service input anywhere in the product is the one-time identity link in §4a, which points at existing real data rather than creating new schedule data. Multi-day/recurring requests (a single one-off slot only). A general-purpose meeting scheduler beyond this specific timetable shape. Any form of user-created or user-joined group — sections are automatic from enrollment data. Chat/messaging. A native mobile app. Multi-institution support — IIITA is hardcoded. Per-student elective-level precision — electives are handled as conservative busy blocks per the whole basket, not tracked per student (no data source exists for that; see `NOTES.md` §21). Anything not in the five screens above.

If a feature isn't visible in the 3-minute video, it is wasted time. Ask before adding anything.

---

## 3. Architecture

Ship It track. Deployed, with a public URL, from day one.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite, TypeScript | Typed client from the Amplify Gen 2 schema |
| Hosting | AWS Amplify Hosting | Public URL in minutes, CI from GitHub |
| Auth | Amazon Cognito, IIITA email domain gate, `role: FACULTY \| STUDENT` custom attribute | The domain gate is the closed-community boundary. The role attribute gates exactly one action: who may hit Confirm. Anyone can view proposed slots and their own dashboard; only faculty/CR can finalize a slot |
| API + DB | Amplify Gen 2 data (AppSync + DynamoDB) | Generated from a schema file, no hand-written CRUD |
| Data ingestion | Amazon Textract on real AAA timetable PDFs → Amazon Bedrock to normalize inconsistent per-program formatting into one schema → DynamoDB | One-time-per-semester batch job we run, not a live user flow. Real AWS work: the PDFs are genuinely unstructured and inconsistent across programs |
| Slot-finding logic | Custom Lambda — interval intersection across all requested sections' timetables, filtered by the request's constraints, ranked by simple heuristics, with a room-availability pass and a blocking-section explanation when no slot satisfies everything | This is the entire product. It needs every affected section's timetable at once — no chatbot can do this, because it doesn't have access to that data |
| Authorization | Cedar | One real policy: only `role: FACULTY` may call Confirm. Small, but genuine — not decorative |
| Notification | ~~Amazon SES~~ dropped | Replaced by the grid-highlight mechanism (§2, §4a) — confirming a slot writes a `ScheduleChange` row that the affected student/teacher dashboards render as a green (scheduled) or distinct (cancelled) highlight on their own timetable grid, instead of an email. Decided Day 2 once the product had dashboards worth checking. |
| Logs | CloudWatch | One real Textract/Bedrock ingestion log line, and one Lambda invocation log, shown on camera |

### The honest call on ingestion — say this in the writeup, don't hide it

Fully automated PDF ingestion is a real risk — accuracy on inconsistent institutional formatting is unknown until tested. The plan: **run Textract + Bedrock for real on actual AAA timetable PDFs and show it working on camera** — that is the genuine AWS story. If ingestion accuracy is too low to trust for the demo on some programs, hand-structure those from the same real PDFs rather than fabricating data. Say plainly in the writeup which parts were automated and which were hand-verified.

### Cost guardrails

No OpenSearch, RDS, NAT Gateway, ECS/Fargate, EKS, or EC2. Everything scales to zero when idle. No embedding/vector search anywhere in this architecture — there's no matching-by-similarity problem here, just structured data and interval math.

---

## 4. Data model

```
User         userId, email, role: FACULTY|STUDENT,
              linkedSection: { program, branch, section } | null   (students)
              linkedFacultyName: string | null                     (faculty)

TimetableSlot slotId, program, branch, section, semester,
              day, startTime, endTime, courseId, room,
              faculty  (added Day 2 — enables the teacher dashboard;
                        backfilled from the real course-legend data in
                        the same source spreadsheet, not fabricated)

SlotRequest   requestId, requesterId, status: PROPOSED|CONFIRMED,
              sections: [{ program, branch, section }],
              constraints: { earliestTime, latestTime, allowedDays, minDurationMins }

ProposedSlot  requestId, day, startTime, endTime, room,
              score, reason,
              blockingSection (present only when no slot satisfies all constraints)

ScheduleChange   (added Day 2, replaces the SES email)
              changeId, relatedRequestId,
              program, branch, section,
              day, startTime, endTime, courseId, room,
              changeType: SCHEDULED|CANCELLED,
              createdAt
```

### 4a. Identity link (student/teacher dashboards)

We have no source for automatic roll-number → section or name → faculty-identity resolution (checked — not publicly available, and not worth the privacy exposure of ingesting a full roster into a public repo even if it were). Until/unless that data becomes available, a student or faculty member links their own login to their own real, already-ingested identity **once**, on first use of their dashboard:

- **Student:** picks their own `{program, branch, section}` from a dropdown of real values already present in `TimetableSlot` — not typed free text, not new schedule data, just pointing at something that already exists.
- **Faculty:** picks their own name from a dropdown of real distinct `faculty` values already present in `TimetableSlot`.

This is the one explicitly-allowed exception to the "no user-entered data" rule in §2's non-goals — it's an identity pointer, not schedule data. If a real roll-number file becomes available, this step is replaced with automatic lookup and nothing else in the data model changes.

---

## 5. The slot-finding algorithm

Input: a `SlotRequest` — the sections that must attend, plus constraints.

1. Pull each section's `TimetableSlot` rows for the week.
2. Intersect free intervals across all of them.
3. Filter by the request's constraints (time window, allowed days, minimum duration).
4. If at least one slot survives: rank by — avoids lunch (12–2), falls within 9am–5pm, not at the very edge of anyone's day — then attach a free room if the timetable data shows one.
5. If **no** slot survives: identify which single section, if excluded, would unblock the most candidate slots, and report it as the reason ("Section B has back-to-back classes all week except Friday 4pm — that's the only slot that works for everyone else").

No ML — correct, explainable interval intersection and a simple bottleneck check. Keep it in its own Lambda so it's testable in isolation with real timetable data.

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

1. **0:00–0:25** The problem, concretely: a professor needing a makeup class, a WhatsApp poll to three CRs, two days of back-and-forth to find one hour.
2. **0:25–0:55** New Request — pick the three sections, set constraints. Show the real Textract/Bedrock ingestion log line — this is the "must show AWS in the video" requirement, do not skip it.
3. **0:55–1:35** Proposed Slots — the ranked result with reasoning and a suggested room, appearing in seconds instead of two days. Then show the no-common-slot case and the blocking-section explanation — this is the moment that proves it's real logic, not a lookup table.
4. **1:35–2:05** Confirm — pick the slot, then cut to a student's (or teacher's) dashboard showing the same slot appear as a live green "scheduled" highlight on their own timetable grid.
5. **2:05–2:35** Architecture diagram and the live URL.
6. **2:35–3:00** What we learned, specifically: what Textract/Bedrock ingestion accuracy actually looked like on real institutional timetable PDFs, and why the scope stayed this narrow.

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
