# 18 — Project Story & Contribution

## Part 1 — The four answers

### 15 seconds: "What is Slate?"

> "Slate coordinates class-schedule changes at IIIT Allahabad. When a professor tells a class rep 'IML makeup this week for sections A, B and C,' Slate finds the one hour that works for every affected section and the professor, in seconds, instead of a day of WhatsApp polling — and every change shows up automatically on every affected student's timetable, with who made it."

### 60 seconds

> "The problem is specific: timetable changes at IIITA get agreed verbally between a professor and a class rep, then spread by WhatsApp. When a makeup class spans several sections, finding one free hour for all of them — and the professor — takes a day of back-and-forth, even though every section's timetable already exists somewhere; nobody's cross-referenced them.
>
> Slate is a React/Vite frontend on Amplify Gen 2 — Cognito gates sign-up to `@iiita.ac.in` emails, AppSync/DynamoDB hold the data, and three Lambdas do the real work: one ingests the actual timetable spreadsheets, one runs the slot-finding algorithm, and one enforces every schedule-change permission through a Cedar policy.
>
> The core model: one class representative per section, first to claim it. A CR records a cancel, an extra class, or a move for a course, and it reaches every section of that course taught by the same professor — because a course like IML can have three different professors across three sections. The finder does interval intersection across every affected section's effective timetable, the professor's timetable in any batch, and even irregular attendees like drop-year students — hard constraints for the sections and professor, soft for stragglers — then ranks by lunch-avoidance and day-edge heuristics and suggests a free room.
>
> And the part I'd lead with: this went through two earlier ideas — a lost-and-found app, and a much broader curriculum tool — before landing here, specifically because this was the one slice with no prior art, a real non-LLM reason to exist, and no second user to invent: the sections it coordinates already exist."

### 3 minutes

> *(Start with the 60-second version, then:)*
>
> "Let me go one level deeper on three things.
>
> **The pivot that actually happened mid-build.** Slate started faculty-driven — a professor logs in and schedules a session, students just watch. By Day 3 we rebuilt it around class reps instead, because that's not how it actually works here: professors don't want another login, they tell the CR, the CR tells the class. `CLAUDE.md` has a literal 'Revision note' documenting that pivot. You can still see the fossil of the old model — `test-faculty@iiita.ac.in` and a FACULTY Cognito group exist in the test-accounts doc from before the rewrite.
>
> **The authorization model.** Every schedule change — cancel, add, move, undo, claim-CR — goes through one Lambda where a real Cedar policy decides, not application `if` statements. The policy is genuinely small: claim your own empty section, act on a course if you're the CR of any section that takes it, undo if you made it or it's your section. The server derives your section from your verified email and a course's affected sections from the actual timetable data — never from anything the client sends. Every decision, allow or deny, gets logged structurally to CloudWatch, which is what we show on camera instead of just saying 'we used Cedar.'
>
> **The ingestion honesty.** The plan was Textract plus Bedrock normalizing real, messy AAA timetable PDFs — genuinely automated, genuinely AWS. Our account's Bedrock quota was zero and couldn't be raised in time, which is an infrastructure wall, not a skill gap. What shipped instead is a deterministic spreadsheet reader that cross-checks its own interpretation of merged cells against each course's declared weekly-hours count, flags what it can't confirm for an admin to review, and never guesses. I'd argue that's actually more trustworthy for a demo than an unvalidated LLM normalization pass would have been — and we say exactly this, plainly, in the README, instead of pretending Bedrock ran."

### 10 minutes — the architecture walkthrough

**Minute 1–2: the problem, precisely.** The information to answer "when's everyone free" already exists, scattered across timetables nobody's cross-referenced — this is a data-integration problem with an interval-math answer, not a chatbot problem. *(→ CLAUDE.md §1, §0's "why AWS, why not an LLM" framing.)*

**Minute 2–4: the pivot and the data model.** Faculty-driven → CR-driven, and why: professors don't want a login, CRs are the real point of contact. Walk through `Batch → Section → TimetableSlot → Occurrence → ScheduleChange`, and the one non-obvious design choice — a course can have a different professor per section (IML: three professors across three sections at IIITA), so a change reaches the professor's sections, not blindly the whole course.

**Minute 4–6: the algorithm.** Trace a real Extra-class request: build each affected section's effective timetable (regular minus cancellations plus extras plus electives), add the professor's timetable in any batch as a hard constraint, add irregular attendees (enrollment exceptions) as soft constraints grouped by identical timetable to avoid per-student cost, intersect, rank by lunch/9-to-5.30/day-edge heuristics, attach a free room, and — if nothing survives — name the one section or professor whose removal unblocks the most slots.

**Minute 6–7: authorization as data, not code.** The Cedar policy file, why it's five rules, why the server (not the client) computes who's allowed to act on what, and the CloudWatch evidence trail.

**Minute 7–8: the honest AWS story.** What's genuinely automated (Cognito domain gate, Amplify Hosting CI, the Lambda pipeline, CloudWatch logging of every Cedar decision and every `slots-found` line) versus what was planned and blocked (Textract+Bedrock ingestion) versus what was deliberately dropped after being built (SES notification, superseded by the in-app feed).

**Minute 8–9: what's wrong with it, unprompted.** DynamoDB scan-everything access patterns (fine at this scale, a real wall past it), no automated test suite (a disciplined manual checklist and ad-hoc Cedar Lambda invocations instead), `BatchWriteCommand`'s dropped `UnprocessedItems` being a real silent-failure gap.

**Minute 9–10: what's next, and what wouldn't change.** The registration-driven data model in `docs/DATA-MODEL.md` — designed, not yet migrated to — would delete most of the section-arithmetic special-casing in favor of "you attend what you're registered for." Say explicitly: the CR model wouldn't change; it's the right fit for how changes actually happen here, and more time would go into data-model cleanup and real ingestion, not a different product shape.

---

## Part 2 — What actually happened, from git history

`git log --oneline` shows roughly 70+ commits from a working repo with a real, traceable build order. Reading it as a narrative rather than a list:

**Early build (schema, algorithm, deploy first):** `6945940 Add Amplify Hosting build spec` → `e0f4f06 Slot finding as a Lambda: ranked slots, reasons, room, blocking section` → `c9ca4c6 Deploy frontend to Amplify Hosting (manual deploy)` — the finder and a live URL existed before most of the UI, consistent with `CLAUDE.md` §10's stated priority ("prefer the smallest thing that runs end to end").

**Faculty-first, then the CR pivot:** `291ead4 Confirm through a Cedar policy in a Lambda` and `fb4835b Faculty can cancel their own classes` are visible faculty-model commits, followed by the actual rewrite: `3e78d4b Students only: a class rep per section keeps its timetable`, `4698d6b Find a Slot: only the student's own batch's sections`, `9800b5d Rewrite the brief for the student/CR product; add the phased plan`, `45ec2aa Dated, course-wide changes and a professor-aware slot finder`, `5eab6ee Brief: changes reach the professor's sections, not the whole course`. This sequence — brief rewritten *alongside* the code, not after — matches `docs/PLAN.md`'s own account of a piecemeal Day-3 pivot that needed a deliberate replan to add up to a coherent product.

**Data correctness found and fixed in production, not assumed:** `df33b1a Keep the roll prefix: IIB2024001 and IIT2024001 are two people`, `41bfa9a Match imported students by prefix, year and number`, `e0f4f06 Student names: imported, shown and searchable`, `5d06049 Ingest electives and whole-batch classes instead of skipping them` — these are bugs found against real, messy institutional data (mixed roll prefixes within one batch, electives silently dropped at import) and fixed with commits that describe the *actual* problem, not a generic "fix bug."

**The registration-driven redesign, planned but not executed:** `0836fa4 Plan a registration-driven data model` produced `docs/DATA-MODEL.md` — a serious, detailed rewrite plan that was never migrated to. This is worth stating plainly as unfinished, ambitious, correctly-scoped-out work, not hidden.

**Design work sequenced last, as instructed:** `8c26aef Merge frontend_updates: UniClass design language`, `78a0514 Headings in Playfair Display`, `d40bcd7 Replace the borrowed logo with Slate's own mark`, `80ebb58 Redesign: the printed timetable, made live` — all landing after the CR pivot and the core flows worked, matching `CLAUDE.md` §2's explicit non-goal ("visual/UI design work until the flows are done").

**Submission hygiene at the end:** `08f56b3 Submission docs: README, writeup and video script`, `f295308 Rewrite the video script for the 3-minute limit`, `079ec29 Add SUBMISSION.md`, `4f9eed8 Remove what doesn't belong in the repo`, `631d078 Put the demo credentials at the top of the README`.

**What this supports saying honestly:** "I can point to the exact commit where the product model changed and why, the exact commits where real data problems were found and fixed, and a plan for a better data model that we scoped out for lack of time rather than lack of insight."

## Part 3 — Why AWS, specifically, and what was learned

`CLAUDE.md` §0 states the hard constraint plainly: this was a Ship It track submission, judged on being genuinely deployed with a public URL, with AWS visibly in use in the demo video — "naming it in the writeup is not enough." That constraint shaped real decisions, not cosmetic ones:

- **Amplify Gen 2 over hand-rolled infra** because it turns one TypeScript schema file into a typed AppSync API, real DynamoDB tables, and generated client types in one deploy — the entire team could build against real types from day one instead of mocking an API contract that might drift.
- **Cognito's pre-sign-up trigger as the actual community boundary**, not application-code email checking — the domain gate is enforced before an account can even exist, which matters for a product whose entire premise is "a closed set of real, verified students."
- **DynamoDB/serverless-only, with an explicit no-list** (no OpenSearch, RDS, NAT Gateway, ECS/Fargate/EKS/EC2, no vector search anywhere) — a deliberate cost and complexity guardrail stated up front in `CLAUDE.md` §3, not a limitation discovered under pressure. The team's actual AWS spend stayed under one cent during development, which is real evidence the guardrail worked.
- **Cedar inside a Lambda, not Amazon Verified Permissions** — `AWS_GUIDE.md` names this exact trade-off as "Path B, the honest fallback" versus the managed-service "Path A," and the team took Path A anyway by embedding `cedar-wasm` directly (`embedded.gen.ts`), getting a real Cedar policy evaluated with real CloudWatch-logged decisions without a separate managed service — arguably the more interesting AWS story precisely because it required understanding what Cedar actually is rather than just wiring up a console service.
- **What was learned, honestly:** that automated ingestion of real institutional data is a genuinely hard, underestimated problem — messy merged cells, inconsistent formats across departments, sections with no faculty listed for some rows — and that a managed AI service (Bedrock) being blocked by an account-level quota with no self-service fix is a real, valuable lesson about not treating "the AWS service exists" as the same as "the AWS service is available to you today." The team's response — build a deterministic, self-validating fallback and say plainly what didn't work — is itself the more mature engineering answer than either hiding the gap or blocking on a support ticket that couldn't resolve within the event.

## Part 4 — Framing this as "tell me about a project you built"

**Open with the hook, not the feature list:**
> "The thing I'd want you to ask about is why this went through two earlier, abandoned ideas before we landed here — because the reason we cut them tells you more about how we think than the feature does."

**The three hooks to have ready:**
1. **"We built the faculty-first version, then threw the model out on Day 3."** → The pivot story: real data about how change actually propagates at IIITA (professor → CR → class) beat the cleaner-looking faculty-login design, and the brief itself was rewritten as part of that, not after.
2. **"A course can have three professors in one batch."** → The one domain fact (IML: three sections, three professors) that made "a change reaches the whole course" wrong, and drove the actual authorization/finder logic to be professor-aware, not just section-aware.
3. **"Our AWS AI service was blocked by a quota we couldn't self-serve fix, so we built something arguably more trustworthy instead."** → Turns an infrastructure failure into the strongest engineering-judgment story in the project.

**Volunteer the weaknesses early, in this order** (see `13_ARCHITECTURAL_IMPROVEMENTS.md` and `11_FAILURE_MODES.md` for the full detail behind each):
1. No automated test suite — a disciplined manual checklist and ad-hoc Lambda invocations instead, and exactly why that was the trade-off made.
2. The registration-driven data model that was designed (`docs/DATA-MODEL.md`) but never migrated to — real, scoped-out follow-up work, not an oversight.
3. `BatchWriteCommand`'s unchecked `UnprocessedItems` — small, concrete, honestly named.
4. PDF ingestion never shipped — quota-blocked, with a deterministic fallback that's actually reasonable to defend.

**If asked "what would you do with one more day":**
> "Write the test suite for `attendance.ts` — it's pure functions over plain data, cheapest and highest-leverage automated coverage available, and every other query in the system depends on it being right. Not a new feature — the thing that would make me trust what's already built."
