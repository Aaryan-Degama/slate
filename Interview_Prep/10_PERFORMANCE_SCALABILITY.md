# 10 — Performance & Scalability

> Ground rule for this document and for the interview: don't invent a number. Slate has no load-test harness and no recorded benchmark run anywhere in the repo. Every number below is either read directly off the code (a real, checkable cost) or marked **[ESTIMATED]**. When asked for a number you don't have, say what you'd measure and how — that answer is stronger than a fabricated one.

---

## 1. The shape of the system, cost-wise

Slate is three Amplify Gen 2 Lambdas behind AppSync, backed by six DynamoDB tables, for a population of roughly **3,000–5,000 students across two departments**. It was built to be correct and explainable in four days, not to scale past one institute. Every access pattern below is `ScanCommand` — a full table scan, every time, in every Lambda. That is the single fact that governs this whole document.

```
grep -rn "ScanCommand" slate/amplify/functions
```
finds it in `section-changes/handler.ts` (`scanAll`, called on `TT`, `SC`, `CR`, `SS`, `RR`, `EN`) and `find-slots/handler.ts` (the same six tables, scanned again, independently, on every `findSlots` call). There are **no GSIs, no query-by-key anywhere in the live path** — `docs/DATA-MODEL.md` §"Access patterns" designs the key schema that would fix this, but it was never implemented; the hackathon build never got past scans.

## 2. Where this is fine, and why

At today's scale every one of these scans is small in absolute terms:

| Table | Realistic row count | Scan cost |
|---|---|---|
| `TimetableSlot` | ~500–1,000 rows (a few hundred sections × ~5 weekly slots) | trivial, single DynamoDB page |
| `StudentSection` | ~3,000–5,000 (one per student) | a few pages, still sub-100ms server-side |
| `RollRange` | dozens | trivial |
| `ClassRep` | one per section, so tens | trivial |
| `Enrollment` | expected to stay small — it only holds *exceptions* (drop-year students, ADD/DROP records), not every student's every course | trivial today |
| `ScheduleChange` | bounded by design — TTL (`expiresAt`) deletes every row the Monday after its week, so this table can never hold more than roughly two weeks of activity across the whole institute | trivial, self-limiting |

`section-changes/handler.ts`'s `mySection` and `batchRoster` queries each fire 2–3 parallel scans (`Promise.all([scanAll(SS), scanAll(RR)])`, plus `CR`). `find-slots/handler.ts` fires five in parallel on every search. At current row counts each scan finishes in tens of milliseconds and DynamoDB's on-demand billing means this literally costs fractions of a cent — the architecture brief's "everything scales to zero when idle" claim is true and was verified by the team staying under one US cent of spend during development (`README.md`).

**The honest claim to make in an interview:** "I know exactly where the bottleneck is because I put it there — every Lambda scans every table on every call. I did that because with roughly a thousand timetable rows and a few thousand students, the constant-factor simplicity of `scanAll` was worth more in four days than early key design I couldn't validate against real usage patterns yet."

## 3. Where it would actually break

### 3a. `find-slots`: the real algorithmic core

The slot finder (`amplify/functions/find-slots/handler.ts`) is the one place with real algorithmic complexity, not just a scan. Walking the actual code:

- `candidates()` generates every gap-free run of N consecutive teaching hours across every candidate date: `O(dates × hours_in_day)` — bounded, small (dates ≤ ~10 given the "this week and next" cap; `HOURS.length` is a fixed daily schedule, maybe 8-10 slots). This is cheap and stays cheap regardless of student count.
- The **irregular-attendee pass** (§5, step 2a of `CLAUDE.md`) is the part that scales with data, not with algorithmic depth: for every distinct `rollId` with an `Enrollment` row, it calls `homeOf()` then `attended()` (both in `shared/attendance.ts`) to compute that student's personal timetable, groups students by identical resulting timetable (`profiles.set(key, ...)` keyed by the sorted slot-id list), then for each of those *groups* — not each student — computes a busy-set intersection. This is deliberately `O(distinct enrollment exceptions)`, not `O(all students)`, because the vast majority of students have zero `Enrollment` rows and never enter this loop at all (`attended()`'s empty-exception path is the default, and `find-slots` only iterates `new Set(enrollments.map(e => e.rollId))`). This is the one piece of real design in the finder: it correctly avoided being `O(student body)` by construction, not by luck.
- The final ranking (`rank()`) is `O(candidates × parties)` where parties = sections + professors + irregular-timetable-groups — at most a handful of each. `freeRoom()` for each surviving candidate is `O(allRooms × roomBusy)`, both small (a few dozen rooms, a few dozen busy intervals per date).
- The blocking-section explanation (when nothing survives) does one more pass per hard party (`options.map(...)`), each re-running `candidates()`-style filtering — `O(hard_parties × candidates)`. With `hard` capped at "a handful of sections + 1-3 professors" this stays cheap.

**Where this actually falls over:** not from more students, but from more *distinct enrollment exceptions*. If drop-year/backlog enrollment became common (say, hundreds of ADD/DROP rows across a batch instead of a handful), the number of distinct timetable "profiles" the irregular pass groups by would grow, and each still triggers a full `attended()` computation (itself scanning `homeBatch` — `O(batch's TimetableSlot rows)`) plus a `held()` filter over all dates. This is `O(distinct_profiles × batch_slots × dates)` — still bounded by realistic numbers for one institute, but it is the one part of the algorithm whose growth isn't structurally capped the way the section/professor side is.

### 3b. The scan-everything pattern, at real scale

The scans are fine today because DynamoDB scans a fixed working set that happens to be small. They stop being fine if either of two things changes:
1. **More institutes.** `CLAUDE.md`'s non-goals explicitly rule out multi-institution support — "IIITA is hardcoded" — which is precisely why this was never an access-pattern problem in scope. If Slate ever served multiple institutes from one table, every scan becomes `O(all institutes' data)` for a query that only needs one institute's slice, and that's the point a GSI on `program|branch|semester` (as sketched, for a different data model, in `docs/DATA-MODEL.md`) stops being a nice-to-have and becomes required.
2. **`ScheduleChange` growth if the TTL stopped working.** The TTL is what keeps this table small — DynamoDB's TTL sweep isn't instantaneous (AWS documents typical deletion within 48 hours of expiry, not the instant `expiresAt` is reached), so at any moment the table can hold a few days of "expired but not yet swept" rows in addition to the live two weeks. At current scale this is invisible; it would only matter if per-Lambda-invocation time started to matter, which it doesn't yet since `findSlots` and `section-changes` both scan `SC` and then filter by `date` in application code anyway (`live = changes.filter((c) => !c.undoneAt && c.date && dates.includes(...))` in `find-slots/handler.ts`) — meaning the scan cost is `O(all rows still in the table)` regardless of TTL sweep timing, just capped at roughly two weeks of institute-wide activity either way.

### 3c. Lambda cold starts

Every one of Slate's three custom Lambdas (`find-slots`, `import-data`, `section-changes`) is a Node.js function bundled by Amplify's `defineFunction`, using the AWS SDK v3 clients (`DynamoDBClient`, `CognitoIdentityProviderClient`) plus, in `section-changes`, the WASM Cedar engine (`@cedar-policy/cedar-wasm/web`, loaded via `initSync` at module scope with a base64-embedded WASM blob, `embedded.gen.ts`). That WASM init happens once per cold start, at import time, before the handler runs — a real, measurable cold-start cost that was never profiled. **[ESTIMATED]**: Node cold starts for a bundle this size (a few hundred KB of JS plus an embedded WASM module) are typically in the 300ms–1s range on Lambda's default Node 18/20 runtime; the WASM `initSync` call adds an unmeasured but nonzero amount on top of that. This never got measured because AppSync's request timeout and the demo's manual testing never made it visible — nobody was pushing enough concurrent traffic during the hackathon to notice. Amplify doesn't configure provisioned concurrency for any of these functions (not in `resource.ts` for any of the three), so every scale-to-zero idle period reintroduces this cost on the next request.

The honest scaling story here: cold starts matter far more to *tail latency for the first user after an idle period* than to steady-state throughput, and for a single-institute app used in bursts around class times (checking your timetable before class, a CR reacting to a professor's WhatsApp message), that's a real, if minor, user-facing cost that was accepted rather than solved.

### 3d. Cognito `AdminGetUserCommand` per caller, cached per Lambda instance only

`section-changes/handler.ts`'s `emailOf()` calls `AdminGetUserCommand` against Cognito for every caller whose email isn't in the access-token claims (the access token Slate authenticates with carries no email claim, per the code comment), and memoizes the result in an in-Lambda-instance `Map` (`const emails = new Map<string, string>()`, declared at module scope). This means: within one warm Lambda instance, repeat calls from the same user are free after the first; across a cold start, or when AppSync/Lambda spins up a new concurrent instance to handle load, it's a fresh Cognito API call. At a few thousand users making occasional CR actions, this is invisible. At real concurrency (many students hitting `mySection` at once at, say, 9am when everyone checks today's timetable) this is `O(concurrent_cold_instances)` Cognito calls, each with its own network round-trip — the first place actual concurrent load, not data volume, would show up as latency.

## 4. What's genuinely fine as shipped, said plainly

- The DynamoDB access patterns are wasteful in the abstract (scans instead of queries) but **entirely adequate for one institute's realistic user count**, and the cost is effectively zero at this scale — this was a real, considered trade-off given four days, not an oversight nobody noticed. `docs/DATA-MODEL.md` shows the team knew exactly what the correct key design would look like and chose not to build it yet.
- `ScheduleChange`'s TTL is a genuinely good scaling decision: it makes the one table with unbounded growth potential self-limiting, for free, with zero application code.
- The finder's irregular-attendee grouping (`profiles.set(key, ...)` keyed by identical timetables) is real algorithmic care — it avoids `O(students)` in favor of `O(distinct irregular timetable shapes)`, which is the correct abstraction for a system where "attends their home section" is the overwhelming default.

## 5. What isn't fine and where the wall is

If this had to serve, say, all of IIIT Allahabad (all programs, not just IT/EC Sem 5) at once, or several sister institutes on shared infrastructure, in order:

1. **No GSIs anywhere** — every one of the six tables would need at least one, keyed the way `docs/DATA-MODEL.md` already sketches for the (unimplemented) offering-based redesign: `program|branch|semester` as a partition key on `TimetableSlot`, `StudentSection`, `RollRange`; `groupId` and `date` as sort keys on `ScheduleChange`.
2. **`section-changes` and `find-slots` both independently scan the same six tables on every call**, with no shared cache layer between them — a single in-request DynamoDB DAX cache or even a short-TTL in-Lambda cache of `TimetableSlot` (which changes only on admin correction, essentially never) would cut real request cost without touching correctness.
3. **The irregular-attendee pass in `find-slots`** would need to move from "compute every distinct profile inline, per request" to a precomputed, invalidated-on-write cache if enrollment exceptions ever became common rather than rare — today's design correctly bets they won't.
4. **Lambda cold starts and the un-memoized-across-instances Cognito lookup** would want provisioned concurrency (a fixed idle cost, in direct tension with the project's zero-when-idle cost story — a real trade-off to make explicitly, not silently) or, cheaper, moving the email lookup to a DynamoDB-backed cache with a short TTL instead of a per-instance in-memory `Map`.

None of this was needed for a four-day hackathon serving two departments' worth of students during a judged demo, and saying so plainly — rather than either pretending it's already solved or pretending it was never considered — is the correct answer to "how would this scale."
