# 17 — Code-Level Interview

> "Open your repo. Explain this line." Every snippet is real, with its file and function.

---

## `amplify/functions/section-changes/handler.ts`

### Q. Walk me through how a Cancel action reaches DynamoDB.

```ts
case 'cancelOccurrence': {
  const date = checkDate(a.date)
  const slots = await scanAll(TT)
  const { slot, batch, together } = await occurrence(String(a.slotId), date, slots)
  authorize(ctx, 'Cancel', courseEntity(ctx, batch, String(slot.courseId), together), 'Only the CR of a section in this class can cancel it.')
  await assertNotCancelled(together, date)
  const rows = cancelRows(ctx, randomUUID(), 'CANCELLED', date, together)
  await writeRows(rows)
  return JSON.stringify({ cancelled: rows.map((r) => r.section) })
}
```

> "Client calls the `cancelOccurrence` AppSync mutation with `slotId` and `date`. `checkDate` first rejects
> anything not in 'today through next week's Friday' — the window is enforced on write, not just filtered on read.
> `occurrence()` looks up the regular `TimetableSlot` by id, checks the weekday matches (`weekdayOf(date) !==
> slot.day` throws), and finds every row 'together' with it — same batch, course, day, start/end time and session
> type — because a class can be held identically for several sections at once, and cancelling it has to cancel
> all of them in one action.
>
> `authorize()` is the Cedar gate: it builds a `Slate::Course` entity whose `crs` list is every CR of every section
> in `together`, and asks Cedar whether this principal may `Cancel` that resource. If denied, it throws before any
> write happens — Cedar runs *before* `assertNotCancelled` and before `writeRows`, so a denied caller never reaches
> DynamoDB at all.
>
> `assertNotCancelled` re-scans `ScheduleChange` and throws if this occurrence is already cancelled/moved on this
> date — preventing a double-cancel race. `cancelRows` builds one row per section in `together`, all sharing one
> `groupId` (from `randomUUID()`), each stamped with `changedBy`/`changedBySection` inside `newRow()`. `writeRows`
> batches them to DynamoDB in chunks of 25 (`BatchWriteCommand`'s hard limit). The response echoes which sections
> were touched."

---

### Q. Show me where Cedar denies a non-CR, exactly.

```ts
function authorize(ctx: Ctx, action: string, resource: Entity, denied: string) {
  const answer = isAuthorized({
    principal: ctx.principal.uid,
    action: { type: 'Slate::Action', id: action },
    resource: resource.uid,
    context: {},
    policies: { staticPolicies: POLICY },
    entities: [ctx.principal, resource],
  })
  if (answer.type === 'failure') throw new Error(`Cedar error: ${answer.errors.map((e) => e.message).join('; ')}`)
  const decision = answer.response.decision
  console.log(JSON.stringify({ cedar: decision, action, email: ctx.email, principal: ctx.principal.attrs, resource: resource.uid.id }))
  if (decision !== 'allow') throw new Error(denied)
}
```

paired with `policy.cedar`:

```
permit (
  principal,
  action in [Slate::Action::"Cancel", Slate::Action::"AddExtra", Slate::Action::"Move"],
  resource is Slate::Course
)
when { resource.crs.contains(principal) };
```

> "`courseEntity()` builds `resource.crs` as the list of `{__entity: user(sub)}` for every CR whose `sectionKey`
> matches a section that holds this course — computed server-side from a fresh scan of `ClassRep` and
> `TimetableSlot`, never from anything the client sent. If the caller's principal isn't in that list, Cedar's
> `when` clause is false, no `permit` statement matches, and `isAuthorized` returns `deny` by Cedar's default-deny
> semantics (nothing explicitly denies here — there's just no permit that applies).
>
> `authorize()` logs the decision *before* checking it — so a denial is logged exactly like an approval, just with
> `decision: 'deny'`. That's the CloudWatch line we show on camera: a non-CR calling `cancelOccurrence` produces a
> `{cedar: 'deny', action: 'Cancel', email: '...'}` log line and the mutation throws `'Only the CR of a section in
> this class can cancel it.'` back to the client — never touching `assertNotCancelled` or `writeRows`."

---

### Q. Why does `emailOf` call Cognito's `AdminGetUserCommand` instead of reading from the `User` table?

```ts
async function emailOf(identity: Identity): Promise<string> {
  if (identity.claims?.email) return identity.claims.email
  const username = identity.username ?? identity.sub
  if (!emails.has(username)) {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID!, Username: username }))
    const attr = (n: string) => user.UserAttributes?.find((x) => x.Name === n)?.Value
    emails.set(username, attr('email_verified') === 'true' ? (attr('email') ?? '') : '')
  }
  return emails.get(username)!
}
```

> "Because the app authenticates with Cognito *access* tokens, not ID tokens, and access tokens carry no email
> claim — so `identity.claims?.email` is usually absent and the fallback path runs. Looking it up from the `User`
> table instead would be a privilege hole: students can edit their own `User` row (it has `allow.owner()`
> authorization in the schema), so a malicious client could write a fake email there and effectively become a
> different roll number's CR. `AdminGetUserCommand` reads Cognito's own verified user pool record directly — the
> one source of truth the caller can't edit — and only trusts it if `email_verified === 'true'`. The per-call
> `emails` Map memoizes the lookup for the Lambda's lifetime, since a cold Lambda invocation may serve several
> field resolutions in one event in some setups, though mainly it avoids redundant Cognito calls in one handler run."

---

### Q. Why does `sectionOf` truncate a sub-section like `B1` down to `B`?

```ts
async function sectionOf(email: string): Promise<Section | null> {
  const r = await resolve(email)
  return r && { program: r.program, branch: r.branch, semester: r.semester, section: r.section }
}
```

where `homeOf` (in `shared/attendance.ts`) already returns `section: sec[0]` — the first character only.

> "Because CR authority is scoped to the *main* section, not the sub-section — `keyOf()`'s own comment says it:
> 'CRs are per main section: a B1/B2 class belongs to B's CR.' A student in B1 is still, for CR purposes, a member
> of B; there's no separate B1 CR concept. `homeOf` already strips to the first character of the section string
> when it builds the `Home` object, so by the time `sectionOf` runs, `r.section` is already just `'B'` — this
> function doesn't do the truncation itself, it inherits it from the shared `attendance.ts` module that both
> `section-changes` and `find-slots` import, keeping that rule defined exactly once."

---

## `amplify/functions/find-slots/handler.ts`

### Q. Walk me through how a professor's busy set is built for the slot search.

```ts
const professors = a.courseId
  ? [...new Set(
      slots
        .filter((r) => r.courseId === a.courseId && r.faculty && groups.some((g) => inBatch(r, g) && (r.section === g.section || blocks(String(r.section), g.section))))
        .map((r) => String(r.faculty)),
    )]
  : []
for (const prof of professors) parties.push({ name: prof, kind: 'professor', busy: held((r) => r.faculty === prof) })
```

> "First it finds which faculty name(s) actually teach *this course to these specific sections* — necessary
> because a course can have a different professor per section (IML in IT Sem 5 has three), so we can't just take
> 'whoever teaches IML anywhere'. `blocks()` handles the section-hierarchy matching (a B class blocks B1 and B2
> queries and vice versa). Dedup with `Set` because the same professor might teach it to multiple of the requested
> sections.
>
> Then for each matched professor, `held((r) => r.faculty === prof)` builds their busy set from *every* row in the
> whole `TimetableSlot` table where `faculty` matches — deliberately not filtered to the CR's batch, because a
> professor teaching one batch's makeup class is still busy if they have a class in a completely different batch
> at that hour. That's why the professor query pulls `faculty` matches globally rather than reusing the `inBatch`
> filter the section parties use."

---

### Q. Explain `held()` and why cancellations/extras are folded in before the intersection runs.

```ts
const held = (keep: (r: Row) => boolean): Busy[] => [
  ...dates.flatMap((date) =>
    slots.filter((r) => r.day === weekdayOf(date) && r.id !== a.ignoreSlotId && !offOn.has(`${r.id}|${date}`) && keep(r))
      .map((r) => ({ date, start: String(r.startTime), end: String(r.endTime), room: r.room ? String(r.room) : undefined, label: `${r.courseId}${r.section === '*' ? ' (elective)' : ` (Sec ${r.section})`}` })),
  ),
  ...added.filter(keep).map((c) => ({ date: String(c.date), start: String(c.startTime), end: String(c.endTime), room: c.room ? String(c.room) : undefined, label: `${c.courseId} (extra class, Sec ${c.section})` })),
]
```

> "This is where 'effective timetable' from CLAUDE.md §4 gets materialized into concrete busy intervals. First half:
> every regular `TimetableSlot` row whose weekday matches a candidate date, *excluding* any that are cancelled/moved
> on that specific date (`offOn`, a Set of `slotId|date` pairs built from live `ScheduleChange` rows earlier in the
> handler) and excluding the slot being moved itself (`ignoreSlotId` — so a Move doesn't see its own old occurrence
> as a conflict). Second half: any live `ScheduleChange` rows that *add* time (EXTRA, MOVED_TO) on those dates.
>
> Doing this fold-in once, parametrized by a `keep` predicate, means every party (a section, a professor, an
> irregular-student profile) gets a correct, per-date effective busy set from one function instead of five
> different ad-hoc filters — a section's `held()` call filters by `inBatch` + `blocks`, a professor's by
> `faculty === prof`. The candidate-slot search afterward (`candidates()` + `freeFor()`) then only has to check
> plain interval overlap against these precomputed busy arrays — no cancellation/extra logic leaks into the
> ranking code."

---

### Q. What does the "blocking explanation" code actually compute?

```ts
if (!ranked.length && hard > 1) {
  const options = all.map((pi) => ({ pi, opened: cands.filter((c) => all.every((o) => o === pi || freeFor(c, o))) }))
  const best = options.sort((x, y) => y.opened.length - x.opened.length)[0]
  ...
}
```

> "When nothing survives the hard intersection (`ranked.length === 0`) and there's more than one hard party
> (`hard > 1`, i.e. at least one section plus something else, or multiple sections), it re-runs the candidate
> filter once per party — but each time *excluding that one party from the free-check* ('every party except `pi`
> must be free'). Whichever party, when excluded, unlocks the most candidate slots is the actual bottleneck. That's
> a leave-one-out search: O(parties × candidates), cheap at these table sizes, and it's the mechanism behind
> CLAUDE.md §5 point 5 — 'report the single section, or the professor, whose removal unblocks the most slots.' If
> even leaving out any one party unlocks nothing, `best.opened.length` is 0 and the handler returns a generic
> 'nothing fits, try other dates' message instead of naming a false culprit."

---

## `amplify/functions/shared/attendance.ts`

### Q. Explain `attended()` — how does an enrollment exception change what a student sees?

```ts
for (const r of homeBatch)
  if (!r.isElective && !drops.has(String(r.courseId)) && (r.section === '*' || inHome(String(r.section), h))) picked.set(String(r.id), r)
if (!electivesKnown) for (const r of homeBatch) if ((r.section === '*' || r.isElective) && !drops.has(String(r.courseId))) picked.set(String(r.id), r)
for (const e of adds)
  for (const r of slots)
    if (r.courseId === e.courseId && sameBatch(r, e) && (e.section === '*' || !e.section ? r.section === '*' || !!r.isElective : heldFor(String(r.section), String(e.section))))
      picked.set(String(r.id), r)
```

> "Three passes building a `Map<slotId, Row>` (dedup by slot id, since a Map naturally collapses double-adds).
> First: every non-elective home-batch class for this student's section, unless it's in their DROP set. Second:
> if this student has no confirmed elective enrollment yet, include *every* elective in their batch — the
> 'electivesUnconfirmed' fallback from CLAUDE.md §2, because until registration data exists we can't know which
> electives they actually take, so we show the whole basket rather than guessing wrong in either direction.
> Third: every ADD exception — a course taken with a *different* section or batch (a drop-year student, a backlog
> retake), matched by `heldFor()` which handles the B/B1/B2 hierarchy the same way `blocks()` does in `find-slots`.
>
> The reason this one function is shared between `section-changes` (a student's own week view) and `find-slots`
> (who must be free for a class) is that both need the *exact same* answer to 'what does this specific roll number
> actually attend' — computing it twice with subtly different logic is how these two features would silently
> disagree, which is exactly the kind of authorization/data bug a shared pure function is meant to prevent."

---

## `amplify/data/resource.ts`

### Q. Why does `TimetableSlot` allow `allow.group('ADMIN')` write but the schema comment says students can "correct" nothing?

```ts
TimetableSlot: a.model({...}).authorization((allow) => [allow.authenticated().to(['read']), allow.group('ADMIN')]),
```

> "Because the only two writers are the Admin Timetable Editor UI (a human fixing a real extraction mistake) and
> the `import-data` Lambda (which itself only runs behind `allow.group('ADMIN')` on the `importData` mutation) —
> both are Cognito-ADMIN-group actions, never a CR or student action. The schema comment ('never edited by
> students/faculty... this is curation of already-ingested data by the admin role, not open editing') is drawing a
> line between *who* can write (only admins, always) and *what* they're doing when they do (correcting a parsing
> mistake against a real source document, not inventing new schedule data). A CR's actions never touch
> `TimetableSlot` at all — they only ever write `ScheduleChange` rows, which is the layered-on-top change record,
> never the underlying regular timetable."

---

## `amplify/auth/pre-sign-up/handler.ts`

### Q. Where exactly does the IIITA-only gate live, and can it be bypassed client-side?

```ts
const ALLOWED_DOMAIN = 'iiita.ac.in'
export const handler: PreSignUpTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email ?? ''
  const domain = email.split('@')[1]?.toLowerCase()
  if (domain !== ALLOWED_DOMAIN) throw new Error(`Sign-up is restricted to @${ALLOWED_DOMAIN} email addresses.`)
  return event
}
```

> "It's a Cognito Pre-Sign-Up Lambda trigger, which Cognito invokes server-side during `SignUp` before the user
> pool creates the account — it can't be bypassed from the client because the client never controls whether this
> Lambda runs; Cognito calls it unconditionally as part of its own managed signup flow, wired via `amplify/auth/
> resource.ts`'s trigger config, not via any API surface the frontend touches. Throwing inside the handler makes
> Cognito reject the `SignUp` call outright with that message. It's a coarse gate — anyone with a real
> `@iiita.ac.in` address can still sign up — but it's the whole closed-community boundary CLAUDE.md §3 describes;
> everything downstream (a student's own section, CR eligibility) assumes every account is a real IIITA email and
> derives further access from that, never re-checking domain membership again."
