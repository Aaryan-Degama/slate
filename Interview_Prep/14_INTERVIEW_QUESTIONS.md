# 14 — Long-Form Interview Questions

> Format: **Q** → **model answer** → **likely follow-up**. These take 2–5 minutes to answer properly.
> For 40-60 short ones, see [15](./15_RAPID_FIRE.md); for adversarial framing see [16](./16_HOSTILE_INTERVIEW.md);
> for "show me the code" see [17](./17_CODE_LEVEL_INTERVIEW.md).

---

## Product

### Q1. What is Slate, in one sentence?

**A.** "A student-run coordination tool for IIIT Allahabad: when a professor tells a class rep 'IML makeup this
week for A, B and C', the CR records it once in Slate, and it reaches every section that takes that course, dated,
attributed, and cross-referenced against every affected section's real timetable — instead of a WhatsApp poll that
half the class misses."

**Follow-up:** *Why is that a product and not just a form?* Because the hard part isn't recording the change, it's
*finding a slot that works* — a makeup class has to dodge every affected section's classes, the batch's electives,
and the professor's other commitments across every batch they teach. That's `find-slots`: interval intersection
over several real timetables at once, something no single person can do in their head, which is exactly why it's
currently done by a day of WhatsApp polling.

---

### Q2. Why is this CR-driven and not faculty-driven? You changed this mid-build — why?

**A.** "We started faculty-driven: a professor logs in and schedules. We flipped it on Day 3 because that's not how
the information actually moves here. The professor tells the CR, verbally or over WhatsApp; the CR is the one who
already has to broadcast it to the section. Building a professor login screen would have modeled a workflow that
doesn't happen, and cost us a day we didn't have.

The CR model also matches how authority already works informally — CRs already carry that role socially. All we
add is: claim it formally (first student to claim a section becomes its CR, admin can revoke), and once you're CR,
Cedar decides what you can touch. Professors never log in; their ingested timetable only feeds the slot-finder as
data, not as an actor."

**Follow-up:** *Doesn't that put a lot of power in one student's hands?* Yes, deliberately — see Q6 and the hostile
version of this in 16_HOSTILE_INTERVIEW.md. The scope is narrow (their own batch's course), every action is
attributed and undoable, and admins can revoke a CR at any time.

---

### Q3. Walk me through what happens when a CR adds an extra class, end to end.

**A.** *(compressed — full trace with file paths in 17_CODE_LEVEL_INTERVIEW.md Q1)*

"In `NewRequest.tsx` the CR picks a course; the sections its professor teaches are pre-selected because a course
can have a different professor per section — IML in IT Sem 5 has three. That calls `findSlots`, an AppSync query
backed by the `find-slots` Lambda, which builds each affected section's *effective* busy set (regular
`TimetableSlot` rows for that weekday, minus that date's cancellations, plus that date's extras, plus electives
treated as busy) and the professor's busy set across every batch they teach, does interval intersection, ranks by
simple rules (avoid lunch, stay in 9–5:30, don't sit at the edge of anyone's day), and attaches a free room.

The CR picks a slot and confirms. That calls `addExtra`, an AppSync mutation, all backed by the `section-changes`
Lambda. It resolves the caller's section server-side from their verified Cognito email (never trusts anything the
client sends), builds a `Slate::Course` Cedar entity listing every CR of every section that takes this course with
this professor, and asks Cedar `isAuthorized` whether this principal may `AddExtra` on that resource. The policy
(`policy.cedar`) permits it only if `resource.crs.contains(principal)`. If allowed, it writes one `ScheduleChange`
row per affected section, all sharing a `groupId`, each stamped with `changedBy` (email) and `changedBySection`.

Every affected student's `mySection`/feed queries then pick that row up — no push, no SES; it's read on next
load, filtered to this week and next by a DynamoDB TTL (`expiresAt`, the Monday after the change's week)."

---

### Q4. Why Cedar instead of just an `if (role === 'CR')` check in the Lambda?

**A.** "Because the authorization logic here isn't a single role check — it's relational. 'You may cancel this
class' depends on whether *you* are the CR of *a section that takes this specific course*, which the server derives
fresh from the timetable and the CR list on every call. Hand-rolling that as nested `if`s across five mutations
(claim, cancel, extra, move, undo — with undo having two different allow-paths: the maker, or a section's own CR)
gets unreadable fast, and unreadable authorization code is exactly where privilege bugs hide.

Cedar makes the policy a single declarative file — five `permit` statements, plus one `principal.role == "ADMIN"`
catch-all — instead of scattered code. It's also auditable independent of the handler: you can read
`policy.cedar` and know exactly who can do what without tracing control flow. And every decision — allow or deny —
gets logged to CloudWatch as structured JSON (`{cedar: decision, action, email, principal, resource}`), which is
what we show on camera to prove a non-CR gets denied, not just that the UI hides a button."

**Follow-up:** *Isn't that over-engineering for 5 rules?* Fair challenge — five `if`s would arguably work. What
Cedar buys beyond the rule count is: the resource attributes (`resource.crs`, `resource.hasCr`) are built fresh
from real DynamoDB data every call, so the *policy* can't be fooled by stale or client-supplied claims — only the
data feeding it can be wrong, and that data comes from a table only the import Lambda writes. It's also a genuine,
demoable AWS/security-adjacent piece for a judged category that scores "what did you learn."

---

### Q5. Why is there no faculty login even now?

**A.** "Two reasons, one product and one scoping. Product: professors don't originate the *record* — the CR does,
after being told by the professor. A faculty login would need its own auth flow, its own screens, and doesn't
change what data the app needs, only who's allowed to type it in. Scoping: it's explicitly a non-goal in the brief
(CLAUDE.md §2) because in a four-day hackathon, every login surface is a full vertical slice — auth flow, role
gate, dashboard, and its own testing — for a feature that doesn't unblock anything the CR flow can't already do.
Their names/faculty field is ingested data, used read-only by `find-slots` to know when a professor is busy."

---

### Q6. Why no vector search / OpenSearch / embeddings anywhere?

**A.** "Because there's no matching-by-similarity problem in this domain. Finding a free slot is exact interval
math over structured rows — a class either overlaps another class or it doesn't; there's no 'roughly similar
timetable' concept that a vector distance would usefully rank. Resolving 'mom' to a person, or 'photos that look
like a beach', needs semantic similarity; 'is 10:00–11:00 on Tuesday free for section B and Prof. X' does not.

Practically: OpenSearch is also expensive to run continuously (it doesn't scale to zero) and adds an entire
service, index-sync problem, and failure mode we don't need for what's fundamentally `filter` + `sort` over a
DynamoDB scan. The cost guardrail in CLAUDE.md §3 is explicit about this — no OpenSearch, RDS, NAT Gateway,
ECS/Fargate, EKS, or EC2; everything scales to zero when idle. `find-slots` is deliberately explainable interval
intersection, not ML, so its output can always be justified with a plain-English reason string, which matters
because a CR needs to trust *why* a slot was picked over another."

---

### Q7. Why not just have students ask an LLM/chatbot to find a slot?

**A.** "Because the hard part is data a chatbot doesn't have: every affected section's live effective timetable
(regular classes minus today's cancellations plus today's extras), the course professor's timetable across every
batch they teach, and irregular students' individual enrollment exceptions — simultaneously, for a whole candidate
date range. No general-purpose chatbot has write access to five DynamoDB tables and the discipline to do exact
interval math over them; if you tried to make one do this by prompting, you'd get plausible-sounding but
unverifiable slot suggestions, which is worse than useless for a scheduling decision people act on.

What an LLM *could* do here is a UI layer on top — 'ask in plain English' — but the actual computation has to be
the deterministic interval-intersection Lambda regardless, because the answer has to be provably correct, not
plausible. We didn't build that UI layer because it wasn't the differentiating problem; the algorithm and the data
model are."

---

## Architecture

### Q8. Why Amplify Gen 2 over hand-written CDK or a plain Express/RDS backend?

**A.** "Time. Four days, and Amplify Gen 2's `defineData` schema (`amplify/data/resource.ts`) generates a typed
AppSync API and DynamoDB tables from one file — no hand-written resolvers for the CRUD models (`TimetableSlot`,
`ScheduleChange`, `ClassRep`, etc.), and a typed client on the frontend for free. The five custom operations that
need real logic (`mySection`, `batchRoster`, `claimCr`, `cancelOccurrence`/`addExtra`/`moveOccurrence`/`undoChange`,
`findSlots`, `parseTimetable`, `importData`) attach Lambda handlers via `a.handler.function(...)` — so Amplify still
gets out of the way exactly where we need real code.

Amplify Hosting also gives a public URL with CI from GitHub in minutes, which matters directly for the Ship It
track's scoring criterion: deployed on AWS with a public URL, not just 'described in the writeup'."

**Follow-up:** *Could you have hand-rolled the auth/API with CDK instead?* Yes, and it'd be more flexible long
term, but every hour spent on infrastructure plumbing in a 4-day hackathon is an hour not spent on the
slot-finding algorithm or ingestion, which is what's actually being judged.

---

### Q9. Explain the ingestion pipeline and why it's built the way it is.

**A.** "Admin uploads the official timetable spreadsheet to S3. `parse-timetable` (a Lambda, `reader.ts`/`table.ts`)
reads it and returns proposed rows plus validation issues, as JSON — read-only, nothing written yet. The admin
reviews that in the app: confirms column mapping (which column is roll number, section, sub-section — see
`importData`'s arguments), sees a preview, corrects what's wrong. Then `import-data` re-reads the same file with
the confirmed mapping, diffs against what's already in DynamoDB, and writes (or does a dry run first).

It's built as an app flow, not a one-off script, because it runs *per semester* — every time a new timetable is
published, an admin repeats this, not a developer running a script by hand. The real AAA sheets are inconsistent
across programs: merged cells, cohort labels like 'All', sub-sections (B1/B2) that don't always follow a clean
pattern. The reader has to handle those and *flag* what it can't confidently read rather than silently guessing."

**Follow-up:** *Did you use Textract/Bedrock like the original plan said?* Be honest here — see Q9 in
16_HOSTILE_INTERVIEW.md and CLAUDE.md §3's own admission. `scripts/bedrock-normalize-timetable.py` exists in the
repo but isn't in the live ingestion path; the live path (`reader.ts`) is a structured spreadsheet reader, not an
OCR/LLM pipeline. That's a real scope cut, made and stated plainly rather than hidden.

---

### Q10. Why DynamoDB over a relational database, given how relational this data model looks (sections, courses, professors, students)?

**A.** "Two reasons. First, Amplify Gen 2's data layer is AppSync + DynamoDB by default — that's the fast path the
whole stack is built around, and RDS would mean provisioning, VPC networking, connection pooling from Lambda, and a
NAT Gateway if the Lambdas need outbound access — all explicitly excluded by the cost guardrail in CLAUDE.md §3,
and all time we didn't have.

Second, the actual query pattern doesn't need joins at read time in the way it looks like it might. Every Lambda
that needs cross-table reasoning (`section-changes`, `find-slots`) does it by scanning the handful of relevant
tables into memory and joining in TypeScript — `scanAll()` plus `Array.filter`/`.map`. That's viable because the
tables are small (one institution's worth of timetable/roster data, not millions of rows) and it keeps the
authorization-relevant joins (which CR belongs to which course) in code we control and can log, rather than in SQL
a Lambda can't easily audit per-request."

**Follow-up:** *Doesn't `scanAll` with DynamoDB Scan get expensive at real scale?* Yes — see the honest weakness
list in 16_HOSTILE_INTERVIEW.md. It's fine at hackathon/single-institution scale; it would need GSIs and query-by-key
before this served a real multi-thousand-student rollout without cost creep.

---

### Q11. Why "this week and next week only" for students — why not full history?

**A.** "Two reasons: product and cost. Product: a schedule-change feed that goes back months is noise — nobody
needs to know a class was cancelled six weeks ago, they need to know what's different *this week and next*, which
is the actual decision-relevant window (can I make it to class tomorrow; is there a makeup next Tuesday).

Cost/mechanism: `ScheduleChange` rows carry a DynamoDB TTL field (`expiresAt`), computed as the Monday after the
change's week, so old rows are deleted automatically by DynamoDB — no cron job, no manual cleanup Lambda, and the
table never grows unbounded. It's also why `checkDate` in `section-changes/handler.ts` rejects any date outside
'today to next week's Friday' at write time — the window is enforced on the way in, not just on the way out."

---

### Q12. Why no room-suggestion feature guarantee — you said you'd drop it if data wasn't there. Is it real?

**A.** "It's real, and it's exactly as good as the source data. `find-slots` collects every room seen in the real
ingested timetable (`allRooms`), marks a room busy wherever a class on that date uses it, and prefers rooms these
sections already lecture in over unfamiliar ones, deprioritizing rooms only ever used for labs (`labRooms`) for a
lecture-style extra class. If a timetable sheet has no room column, this degrades gracefully to 'no room suggested'
for that program rather than fabricating one — the confirmation in CLAUDE.md §6 was to check this before building
it, and the code path assumes rooms may simply be absent."

---

### Q13. Why cut voting/approval flows between CR and students?

**A.** "Because it turns a fast coordination tool into a slow committee. The real-world process is already
single-decision: the professor tells the CR, the CR tells the section. Adding a vote/approval step models a
consensus process that doesn't exist today and would make the tool slower than the WhatsApp poll it's replacing —
the entire value proposition is *speed and correctness*, not democratic process. Multiple CRs across sections
taking the same course can each act (any one of them can add the extra class), and any of them can undo it for
their own section if it doesn't work for them — that's the actual conflict-resolution mechanism, not a vote."

---

### Q14. What did you actually learn building this (for the "what we learned" judging criterion)?

**A.** "Two concrete things worth naming on camera: first, how genuinely inconsistent real institutional
spreadsheet data is — merged cells, an 'All' cohort label meaning something structurally different from a named
section, sub-sections that don't follow a predictable naming convention across programs — and that no ingestion
pass can silently paper over that; it has to surface what it can't parse rather than guess. Second, that
relational, cross-cutting authorization (not 'is this user an admin' but 'is this user the CR of a section that
takes this specific course, right now, according to live data') is a genuinely different problem from simple
role-based access control, and a declarative policy engine like Cedar earns its complexity there in a way a single
`if` statement wouldn't."
