# 19 — Cheat Sheet

> One page, last glance before walking in.

---

## Elevator pitch

"At IIIT Allahabad, timetable changes — a cancelled lecture, a makeup class, a moved session — are agreed between
a professor and the class rep, then spread by WhatsApp. Half the class misses them, and when a makeup class has to
work for several sections at once, finding one common free hour takes a day of polling. Slate lets the CR record
the change once; it reaches every affected section instantly, dated and attributed, and a slot-finding Lambda does
the interval-intersection nobody does well by hand — across every affected section, the batch's electives, and the
professor, with a free room and a reason, or an explanation of who's blocking it."

---

## The stack, in one table

| Layer | Technology | Note |
|---|---|---|
| Frontend | React + Vite, TypeScript | typed client generated from the Amplify schema |
| Hosting | AWS Amplify Hosting | public URL, CI from GitHub push |
| Auth | Amazon Cognito | `@iiita.ac.in` domain gate (pre-sign-up Lambda), `ADMIN` group |
| API | AWS AppSync (Amplify Gen 2 `defineData`) | typed GraphQL, 5 custom Lambda-backed ops |
| DB | Amazon DynamoDB | 7 models, on-demand, no VPC/RDS |
| Compute | 5 AWS Lambda functions | see below |
| AuthZ | Cedar (`cedar-wasm`) inside `section-changes` | 5 `permit` rules, every decision logged |
| Logs | CloudWatch | Cedar allow/deny lines, `slots-found` line |

## The 5 Lambda functions

| Function | Trigger | Job |
|---|---|---|
| `pre-sign-up` | Cognito PreSignUp trigger | reject non-`@iiita.ac.in` signups |
| `parse-timetable` | `parseTimetable` query (ADMIN) | read S3 file, return proposed rows + issues |
| `import-data` | `importData` mutation (ADMIN) | re-read, diff, write DynamoDB (or dry run) |
| `find-slots` | `findSlots` query | interval intersection, ranking, room suggestion |
| `section-changes` | `mySection`/`batchRoster`/`claimCr`/`cancelOccurrence`/`addExtra`/`moveOccurrence`/`undoChange` | Cedar-gated writes/reads |

## Data model — field list

```
User            email, role (display only), linkedSection (json), changesSeenAt
TimetableSlot   program, branch, section ('*' = whole batch), semester, day,
                startTime, endTime, courseId, room, faculty, sessionType (L/P/T),
                isElective
ScheduleChange  groupId, kind (CANCELLED|EXTRA|MOVED_FROM|MOVED_TO), date,
                program, branch, semester, section, startTime, endTime, courseId,
                sessionType, room, faculty, relatedSlotId, changedBy,
                changedBySub, changedBySection, undoneBy, undoneAt, expiresAt (TTL)
ClassRep        sectionKey ("program|branch|semester|section"), program, branch,
                semester, section, sub (Cognito id), email
RollRange       admissionYear, program, branch, semester, minRoll, maxRoll, section
StudentSection  admissionYear, rollNumber, rollPrefix, name, program, branch,
                semester, section, subSection      (ADMIN write-only)
Enrollment      rollId, courseId, action (ADD|DROP), program, branch, semester,
                section                            (ADMIN write-only)
```

## Cedar policy — the 5 rules (`amplify/functions/section-changes/policy.cedar`)

```
ClaimCr    → principal.section == resource.key && !resource.hasCr
Cancel/AddExtra/Move → resource.crs.contains(principal)     (resource is Course)
UndoGroup  → resource.maker == principal                    (resource is Change)
UndoSection→ resource.hasCr && resource.cr == principal      (resource is Section)
* (any)    → principal.role == "ADMIN"
```
All resource attributes (`crs`, `hasCr`, `cr`, `maker`) are computed server-side from live DynamoDB scans in
`section-changes/handler.ts` — never trusted from the client. Every `isAuthorized` call logs `{cedar: decision,
action, email, principal, resource}` to CloudWatch.

## Key file paths

```
amplify/data/resource.ts                         — schema + API definition
amplify/auth/pre-sign-up/handler.ts               — IIITA domain gate
amplify/functions/section-changes/handler.ts      — Cedar-gated mutations/queries
amplify/functions/section-changes/policy.cedar    — the 5 permit rules
amplify/functions/find-slots/handler.ts           — interval intersection + ranking
amplify/functions/shared/attendance.ts            — homeOf() / attended() — shared by both Lambdas
amplify/functions/parse-timetable/reader.ts       — spreadsheet reader (real ingestion path)
amplify/functions/import-data/handler.ts          — diff + write to DynamoDB
scripts/bedrock-normalize-timetable.py            — NOT in the live path (original OCR plan)
src/App.tsx                                       — role/CR routing (Student/Admin shells)
src/NewRequest.tsx                                — CR's "Make a change" flow
src/StudentDashboard.tsx                          — week view + "What changed" feed
```

## Algorithm — `find-slots`, one line each

1. Effective busy set per section: regular classes that weekday − that date's cancellations + that date's extras
   + electives (busy, conservative).
2. Professor's busy set: their regular classes + extras, across **every** batch they teach.
3. Sections + professor are **hard** (must be free); irregular enrollment-exception students are **soft** (ranked
   last, named if clashing).
4. Intersect free intervals; filter by time window / duration.
5. Rank: avoid lunch (12:00–14:30), stay in 9:00–17:30, avoid the edge of anyone's day; attach a free room.
6. Nothing fits → leave-one-out search names the single section/professor whose removal unlocks the most slots.
No ML — explainable interval math, one Lambda.

## 3-minute demo script beats

1. **0:00–0:25** — the problem: professor tells CR, WhatsApp poll starts, half the class misses it.
2. **0:25–0:50** — student's week view (date-based); show AWS: Cognito sign-in + admin upload (S3 + Lambda parse).
3. **0:50–1:40** — CR flow: Extra class → course → sections pre-selected → dated slots with reasons + room; then
   the no-slot case with the blocking explanation.
4. **1:40–2:10** — Confirm; cut to Sec A student seeing the change + CR attribution in their feed; a non-CR
   denied — show the Cedar deny line in CloudWatch.
5. **2:10–2:35** — architecture diagram + live URL.
6. **2:35–3:00** — what we learned: real institutional ingestion mess, why CR-not-faculty fits how changes happen.

## Cost guardrails (say these if asked "why not X")

No OpenSearch (no similarity-matching problem — exact interval math). No RDS/VPC/NAT Gateway (DynamoDB + Lambda-
memory joins are enough at this scale). No ECS/Fargate/EKS/EC2 (everything scales to zero idle). No embeddings/
vector search anywhere.

## Things to say plainly, not hide

- Textract/Bedrock OCR is **not** in the live ingestion path; the live reader is a structured spreadsheet parser.
  `scripts/bedrock-normalize-timetable.py` exists but is unused.
- `scanAll()` full-table-scans DynamoDB — fine at hackathon scale, needs GSIs before real institution scale.
- No rate limiting or anomaly detection on CR actions — attribution + admin revoke + undo are the only backstops.
- Faculty never log in; no mechanism verifies a CR's claim about what a professor actually said.
