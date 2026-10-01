# LESSON.md — lessons from Slate, for the next AWS hackathon

**Who this is for:** Claude Code (and us) at the start of the next AWS-based hackathon.
**Companion file:** [`AWS.md`](AWS.md) explains every AWS service, its configuration and the request flows in detail.
**How to use it:** copy this file into the new repo and add one line to the new `CLAUDE.md`: *"Read `LESSON.md` before planning. Repeat what scored; fix what held us back."* Everything here comes from what we actually built in Slate (First Commit, WeMakeDevs × AWS, Sept 2026) and from what the judges actually wrote about it.

---

## 1. The result

**26 / 30**, marked Sep 23, 2026.

| Criterion | Score | What it tells us |
|---|---|---|
| AWS Usage | **9 / 10** | The architecture was the standout. Keep the patterns in §3 |
| Idea and Impact | **7 / 8** | A real, narrow, personal problem works |
| Execution | **4 / 4** | It ran, live, on real data. Keep doing that |
| Demo Video | 3 / 4 | Lost a point. No comment given, see §5.3 |
| Design & Usability | 3 / 4 | Lost a point. No comment given, see §5.3 |

**The judge's words, verbatim where it matters:**

Liked:
- "Super concrete, real problem with a real user base … Slate turns that into seconds."
- "**The best-designed AWS setup I've seen in this batch.** Cognito with a pre-sign-up Lambda that only allows @iiita.ac.in emails, admin rights from a Cognito group, AppSync + DynamoDB with per-model auth rules, and the Student table locked to ADMIN."
- "**Cedar is done properly.** The policy is evaluated with cedar-wasm inside the section-changes Lambda, and ScheduleChange is read-only for users in AppSync, so nobody can skip the policy by calling the API directly. Deriving the section from the verified email instead of trusting the client is exactly right."
- "Nice details: DynamoDB TTL on expiresAt so changes clean themselves up, a diff before any import, validation against the sheet's own course legend, and find-slots explaining who's blocking when nothing fits."
- "Really sensible cost thinking: no EC2, NAT, RDS or vector store because the problem doesn't need them. Under a cent for four days is great."

Held it back:
- "**No automated tests in the repo**, which matters for logic like slot-finding and timetable parsing."
- "**It's built for one institute's spreadsheet format**, so reusing it elsewhere would need more work (though that focus is also its strength)."

---

## 2. Non-negotiables for next time (the short version)

1. **One real problem, one vertical slice, deployed from day one.** Every feature is on the live URL before the next one starts.
2. **Identity and authorization are server-side, always.** The client never says who it is or what it belongs to. The server derives it from the verified token and looks up everything else.
3. **Every write that matters goes through one Lambda with a real policy engine (Cedar) and a JSON log line per decision.** The model is read-only to users in AppSync, so nobody can bypass that Lambda.
4. **Least privilege per resource:** sensitive tables are restricted to a group, and Lambdas get exactly the table grants they need (`grantReadData` vs `grantReadWriteData`).
5. **Serverless, scale-to-zero only.** No EC2, NAT, RDS, OpenSearch, ECS or vector stores unless the problem truly needs them. Write that reasoning down. Report the real cost.
6. **Let the platform do housekeeping:** TTL instead of cleanup jobs, Cognito triggers instead of app-side checks.
7. **Imports are two-phase: dry-run diff, then apply.** Validate input against its own internal references.
8. **Algorithms explain themselves,** both why a result was chosen and who blocks it when nothing fits.
9. **NEW: tests from day one** for every pure-logic module, the policy file and the parsers, run in CI on every push. (This was our biggest deduction.)
10. **NEW: keep the core generic.** Source formats and institution-specific details go behind an adapter and a config file, so the writeup can honestly say "a new X is one adapter."

---

## 3. What scored, how we built it, and how to do it again

Paths refer to the Slate repo. Snippets are trimmed to the essential lines.

### 3.1 Problem choice → "Super concrete, real problem with a real user base"

**What we did:** we picked a pain we live with (timetable changes at IIITA lost in WhatsApp; days of polling to find a makeup slot). We narrowed it twice: lost & found → curriculum + timetable tool → just the change-and-slot-finder. We chose a feature with no prior art, a clear "why isn't this just an LLM?" answer (it needs everyone's timetables at once), and **no cold-start problem**, because the groups it coordinates (sections) already exist.

**We let real data change the product.** We checked two things before building: does this really happen, and are rooms in the real sheets? Both answers changed the design (CR-driven, not professor-driven; free-room suggestions are real). On day 4 the institute's registration list replaced our section-based model with offerings and registrations, and that deleted more code than it added.

**Do again:**
- Pick a problem the team personally has, where the users already exist as a group, so the product doesn't need a community built first.
- Get **real data** on day 1 and build on it. "1,801 students, 104 offerings, 4,821 registrations from the institute's own files" is far more persuasive than fixtures.
- Write down which features are deliberately out of scope (non-goals) and hold to it.

### 3.2 Cognito: domain gate plus admin group → "best-designed AWS setup"

**What we did** (`slate/amplify/auth/`):

```ts
// pre-sign-up/handler.ts: the closed-community boundary
export const handler: PreSignUpTriggerHandler = async (event) => {
  const domain = (event.request.userAttributes.email ?? '').split('@')[1]?.toLowerCase();
  if (domain !== 'iiita.ac.in') throw new Error('Sign-up is restricted to @iiita.ac.in email addresses.');
  return event;
};

// resource.ts
export const auth = defineAuth({
  loginWith: { email: true },
  // Admin rights come from this group, NOT a role field on a User row:
  // users can edit their own row, but only the AWS account adds group members.
  groups: ['ADMIN'],
  triggers: { preSignUp },
});
```

**Do again:** enforce the community boundary in a Cognito trigger, never in the UI. Grant privilege through Cognito groups. A `role` field on a user-editable model is for display only.

### 3.3 AppSync + DynamoDB per-model auth → "Student table locked to ADMIN"

**What we did** (`slate/amplify/data/resource.ts`): every model has an explicit rule, chosen per model:

| Model | Rule | Why |
|---|---|---|
| Reference data (Course, Offering, ClassMeeting, TimetableSlot) | `allow.authenticated().to(['read']), allow.group('ADMIN')` | Everyone reads, only admins write |
| Personal data (Student, StudentSection, Enrollment) | `allow.group('ADMIN')` only | Students never list other students directly |
| ScheduleChange | `allow.authenticated().to(['read'])` **only** | No user can write it through AppSync, so writes must go through the policy Lambda |
| ClassRep | read for all; `ADMIN` read + delete | Claiming goes through the Lambda; revoking is an admin delete |
| User | `allow.owner()` + authenticated read | Own profile only |

When students need a **scoped view** of admin-only data (their own batch's roster), we don't open the table. We add a **custom query backed by a Lambda** that returns just that slice (`batchRoster`, `mySection`, `myTimetable`).

**Do again:** decide each model's rule deliberately, and write it in a table like this one in the README. Expose personal data only through scoped custom queries.

### 3.4 Writes only through a Cedar Lambda → "Cedar is done properly"

**What we did** (`slate/amplify/functions/section-changes/`):

1. **A real policy file**, `policy.cedar`, readable by a judge:
   ```cedar
   // Claim: your own section, and only while it has no CR.
   permit (principal, action == Slate::Action::"ClaimCr", resource is Slate::Section)
   when { principal.section == resource.key && !resource.hasCr };

   // Cancel / add / move: a CR of a section that offering is taught to.
   permit (principal, action in [Slate::Action::"Cancel", Slate::Action::"AddExtra", Slate::Action::"Move"],
           resource is Slate::Offering)
   when { resource.crs.contains(principal) };

   permit (principal, action, resource) when { principal.role == "ADMIN" };
   ```
2. **Embedding the engine:** the Lambda bundler can't load `.wasm` or `.cedar` files, so `resource.ts` writes both into a generated, gitignored module at synth time:
   ```ts
   writeFileSync(here('./embedded.gen.ts'),
     `export const POLICY = ${JSON.stringify(readFileSync(here('./policy.cedar'), 'utf8'))}\n` +
     `export const CEDAR_WASM_BASE64 = '${readFileSync(wasm).toString('base64')}'\n`);
   ```
   and the handler calls `initSync({ module: Buffer.from(CEDAR_WASM_BASE64, 'base64') })`.
3. **One `authorize()` function** that every mutation calls. It builds entities from **server-side lookups only**, asks Cedar, logs the decision as one JSON line, and throws on deny:
   ```ts
   console.log(JSON.stringify({ cedar: decision, action, email: ctx.email, principal: ctx.principal.attrs, resource: resource.uid.id }))
   if (decision !== 'allow') throw new Error(denied)
   ```
4. **AppSync can't bypass it**, because the model is read-only (§3.3). All mutations (`claimCr`, `cancelOccurrence`, `addExtra`, `moveOccurrence`, `undoChange`) are custom mutations with `a.handler.function(sectionChanges)`.
5. **The deny is shown on camera** via `aws logs tail … | grep cedar`.

**Do again:** use the same shape: a policy file, an embedded engine, one authorize function, structured logs, and a read-only model. If the next problem has any "who may do what" question, Cedar (or Amazon Verified Permissions if it's allowed and cheap) is a scored differentiator, not overhead.

### 3.5 Server-derived identity → "Deriving the section from the verified email … is exactly right"

**What we did:** Amplify's client uses Cognito **access tokens, which carry no email claim**. Our first version trusted what the browser sent. Manual tests passed because the test harness supplied the email, but every real CR action failed. The fix:

```ts
// Look the verified email up in the user pool by the token-verified username.
// Never from the User table: users can edit their own row there.
const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID!, Username: username }))
emails.set(username, attr('email_verified') === 'true' ? (attr('email') ?? '') : '')
```

plus, in `backend.ts`:

```ts
backend.sectionChanges.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId);
backend.auth.resources.userPool.grant(changesFn, 'cognito-idp:AdminGetUser');
```

From the verified email we derive the roll number, then look up the section in the admin-uploaded list. The server never accepts a section, group or role from the client.

**Do again:** in every Lambda, the caller's identity is `event.identity` plus server lookups, and nothing from `arguments`. Write a test that sends an event **shaped like the real one** (access-token identity, no email claim). See §4.1.

### 3.6 DynamoDB TTL → "changes clean themselves up"

```ts
// backend.ts
backend.data.resources.cfnResources.amplifyDynamoDbTables['ScheduleChange'].timeToLiveAttribute = {
  attributeName: 'expiresAt', enabled: true,
};
```

Each row is written with `expiresAt` set to the epoch seconds of the Monday after its week. There's no cron job and no cleanup code, and it's free.

**Do again:** any data with a natural lifetime (sessions, notifications, short-lived changes, OTPs) gets a TTL attribute on day 1.

### 3.7 Ingestion: S3 → parse → validate → diff → apply → "a diff before any import, validation against the sheet's own course legend"

**What we did:**
- The admin uploads the raw `.xlsx` to S3 (`defineStorage`, path writable only by `ADMIN`, readable only by the two Lambdas). A 16,000-row file never passes through the browser.
- `parse-timetable` (a query, so read-only) returns proposed rows plus **typed validation issues**: `unknown-course` (not in the sheet's own legend), `hours-mismatch` (legend L-T-P vs what the grid shows), `room-clash`, `section-clash`, `unverified-duration`.
- `import-data` (a mutation with a `dryRun: boolean` argument) re-reads the file, diffs against DynamoDB and, only when `dryRun` is false, writes. The UI shows the diff first.
- Rows that can't be matched are **reported, never guessed** (about 2,100 registration rows matched no class; the admin is told).

**Do again:** for any user-supplied data, use parse → issues → dry-run diff → explicit apply. Validate the input against references inside the input itself (legends, totals, headers), so we never need to hardcode expected values.

### 3.8 An explainable algorithm in its own Lambda → "find-slots explaining who's blocking"

**What we did** (`find-slots/handler.ts`): interval intersection over every attendee's effective timetable plus the professor's, constraint filtering, simple ranking rules whose reasons are written out ("free for all 109 registered students · Dr. X is free · avoids the lunch hours"), a free-room pass and, when nothing fits, a **bottleneck report** naming the section or professor whose removal unblocks the most slots.

**Do again:** prefer deterministic, explainable logic over ML or LLM calls when the data is structured, and say *why* in the writeup. Always handle the empty-result case with an explanation, which also makes good video footage.

### 3.9 Cost thinking → "Under a cent for four days is great"

**What we did:** Amplify Hosting, Cognito, AppSync, DynamoDB (on-demand), S3, Lambda and CloudWatch. Everything scales to zero, and we reported the real cost: **$0.00 month-to-date**. We listed what we *didn't* use and why: "no NAT, no EC2, no OpenSearch, no vector store, because there's no similarity problem here."

**Do again:** put a cost line and a "services deliberately not used" line in the README and the writeup. Show the Billing page or Cost Explorer for a second in the video.

### 3.10 Submission packaging (helped Execution 4/4)

- **Demo credentials at the very top of the README**, plus `SUBMISSION.md` with "what to try in two minutes." Judges could sign in despite the domain gate.
- `WRITEUP.md` with an **"Honest limitations"** section (Textract was planned but not in the live path, the reasons, and what's unmatched). Honesty read as maturity, not weakness.
- `CREDITS.md` listing every library, template, font and **every AI tool**, with what each one did.
- A video script mapping each segment to a judging criterion, with exact pre-record setup (accounts signed in, clean state, a terminal pre-typed).
- A Mermaid architecture diagram in the README. (Quote labels containing `@`, or GitHub won't render it.)

---

## 4. What held us back, and exactly what to do instead

### 4.1 "No automated tests in the repo" → tests are part of the definition of done

The irony: Slate's core logic was *already* written as testable pure functions (`amplify/functions/shared/attendance.ts`: `parseRoll`, `homeOf`, `attended`; the reader in `parse-timetable/reader.ts`; interval math in `find-slots`). We just never wrote the tests. The worst bug of the build (§3.5) would have been caught by one handler test with a realistic event.

**Rules for next time:**

1. **Add Vitest on day 1** (one devDependency; pre-approve it in the new `CLAUDE.md` so Claude doesn't have to ask). Script: `"test": "vitest run"`.
2. **Split every Lambda** into `handler.ts` (I/O: DynamoDB, S3, Cognito) and `logic.ts` (pure functions). Test `logic.ts` directly.
3. **What must have tests before it ships:**

   | Area | Test |
   |---|---|
   | Core algorithm (e.g. slot finding) | Table-driven: overlapping intervals, back-to-back classes, empty result returns a blocker, constraints (window, length), ranking order |
   | Parsers | A **small real fixture file** committed in `test/fixtures/` (anonymised), with snapshot or explicit assertions on rows and issues. One fixture per notation we support |
   | Policy (Cedar) | A permit/deny matrix: for each (role, action, resource state), the expected decision. Run against the real `policy.cedar` using `@cedar-policy/cedar-wasm/nodejs` |
   | Identity | A handler test with an **access-token-shaped** `event.identity` (no email claim, `sub` + `username` only) and a mocked `AdminGetUser`. Proves we never read identity from `arguments` |
   | Date/time helpers | Timezone edges (IST vs UTC), week boundaries, weekends |
4. **CI runs them:** add `npm test` to the `amplify.yml` build phase (or a GitHub Actions workflow running lint + typecheck + test), so a red test blocks deploy. Put a test badge or count in the README.
5. **Say it in the writeup:** "N tests cover the slot finder, the parser (against real sheets) and every Cedar rule." Judges look for this.
6. When Claude finishes a feature, the order is: **logic → tests passing → deploy → verify on the live URL → commit → push.**

Example of the policy matrix (cheap to write, very convincing):

```ts
import { isAuthorized } from '@cedar-policy/cedar-wasm/nodejs'
const POLICY = readFileSync('amplify/functions/x/policy.cedar', 'utf8')
it.each([
  ['own section, vacant',   { section: 'IT|5|C' }, { key: 'IT|5|C', hasCr: false }, 'allow'],
  ['own section, taken',    { section: 'IT|5|C' }, { key: 'IT|5|C', hasCr: true  }, 'deny'],
  ['other section, vacant', { section: 'IT|5|A' }, { key: 'IT|5|C', hasCr: false }, 'deny'],
])('ClaimCr: %s', (_, principal, section, expected) => { /* build entities, assert decision */ })
```

### 4.2 "Built for one institute's spreadsheet format" → generic core, institution-specific adapters

IIITA specifics were spread through the code: the `@iiita.ac.in` domain in the trigger, a roll-number regex (`iit2024245`), the hour grid, the sheet notations (`IML (L) - Sec A (CC3-5404)`), and the 12:00–14:30 lunch window.

**Rules for next time:**

1. **One `config` module (or SSM parameter / env) for every deployment-specific value:** allowed email domains, ID format, working hours, breaks, time zone. The pre-sign-up trigger reads `ALLOWED_DOMAINS` from env, not a constant.
2. **An adapter interface for every external format:**
   ```ts
   interface SourceAdapter {
     detect(file: Workbook): boolean          // "is this my format?"
     parse(file: Workbook): { rows: CanonicalRow[]; issues: Issue[] }
   }
   ```
   The core (schema, policy, algorithm, UI) only ever sees `CanonicalRow`. Ship one real adapter, plus a trivial **generic CSV adapter** (documented columns) so a second institution can onboard without code.
3. **Name it in the writeup:** "Adding a new institution = one adapter + one config file; the core is unchanged." Keep the focus on one real user base (the judge called it a strength). Just make the seams visible.
4. Don't over-build: one real adapter, one generic adapter, a config file. Not a plugin system.

### 4.3 Points lost without a comment (our best guesses; treat as hypotheses)

- **Design & Usability 3/4.** Our own `CLAUDE.md` said "no visual/UI design until the flows are done," so the UI pass got squeezed into day 4 (fonts changed three times in the log: DM Sans → Plus Jakarta Sans → DM Sans + Playfair). Next time: **pick a design system on day 1** (font, colour tokens, spacing, one component library or a small set of CSS variables) and don't revisit it. Budget a **fixed half-day for UI polish** on day 3, not day 4. Check mobile width, empty states, loading and error states (we had a "stuck on Loading…" bug), and keyboard focus. A separate Best UI prize existed and we weren't in contention.
- **Demo Video 3/4.** Three speakers and three handoffs in 3 minutes are risky, and the script was rewritten on the last evening. Next time: **lock the script by the end of day 3**, rehearse twice, keep one continuous story with few voices, show AWS on screen (console, logs, cost) rather than describing it, add captions, and make sure the video link works without sign-in *before* submitting (our `SUBMISSION.md` still had "paste the link here").
- **AWS 9/10.** Likely candidates: the planned Textract + Bedrock ingestion wasn't in the live path (we were honest about it, but it was promised in the plan); production ran from a **personal `ampx sandbox`** stack with a manual frontend deploy instead of an Amplify-connected branch with CI (`docs/TEAM-SETUP.md` §B was "do this when there's time"); and the Lambdas full-table `Scan` everything (32 scan call sites) even though the schema defines GSIs. Next time: connect the repo to Amplify Hosting on day 1 so `main` deploys backend + frontend through `amplify.yml`; use `Query` on GSIs for hot paths; only promise AWS services in the plan that will actually run in the demo.
- **Idea 7/8.** Probably reach: one department, one institute. The adapter story (§4.2) and a sentence on how it scales to other colleges should help.

### 4.4 Process mistakes to avoid

- **Commit history must match the event window.** Ours clusters on Sept 19–20 (48 commits in one day) with README edits on Sept 21 and 23, after the event closed on the 20th. If the rules check git dates, that's a risk. Commit small and often from hour one, and **finish docs before the deadline**. If post-deadline commits are allowed at all, keep them to typo-level and say so.
- **Pivots cost us a day.** We went faculty-driven → CR-driven on day 3, and section-based → registration-based on day 4. Validate *who the user is* and *what the source data really looks like* on day 1 (talk to one real user; open the real files), before building screens.
- **Plan vs reality drift.** `CLAUDE.md` still described Textract and `TimetableSlot`-based attendance after the code had moved on. Keep the brief current, or judges and Claude will read stale claims.

---

## 5. Amplify Gen 2 gotchas we already paid for

| Gotcha | Fix |
|---|---|
| Access tokens have **no `email` claim** | `AdminGetUser` by `identity.username`, check `email_verified`, grant `cognito-idp:AdminGetUser` (§3.5) |
| Function resolvers put `fieldName` at the **top level**, not under `info` | `const field = event.fieldName ?? event.info?.fieldName` |
| Lambda that reads data tables causes a **circular stack dependency** | `defineFunction({ …, resourceGroupName: 'data' })` |
| Lambda bundler can't load `.wasm` / `.cedar` | Generate an embedded module at synth time in `resource.ts`; gitignore it |
| `generateClient()` at module top level runs before `Amplify.configure()` | Put `Amplify.configure(outputs)` in its own module (`amplifyConfig.ts`) imported first |
| DynamoDB TTL isn't in the schema DSL | Set it on `cfnResources.amplifyDynamoDbTables[Model].timeToLiveAttribute` in `backend.ts` |
| AWS SDK version mismatches inside the Amplify CLI | Pin `@aws-sdk/*` via `overrides` in `package.json` |
| Deploys hang (`ETIMEDOUT`) behind the campus proxy | `NODE_OPTIONS="--require ./scripts/force-proxy.cjs" npx ampx sandbox --once` |
| `amplify_outputs.json` is per-person and gitignored | Each dev runs `npx ampx generate outputs --stack … ` (or `--app-id … --branch main`) |
| Domain-gated sign-up blocks judges | Pre-create demo accounts with `admin-create-user`; publish them in the README; keep real credentials out of git |
| GitHub Mermaid breaks on `@` in labels | Quote the label: `COG["Cognito<br/>@domain gate"]` |

---

## 6. A four-day plan template, with the lessons applied

| Day | Must exist by end of day |
|---|---|
| **1** | Repo + first commit in the event window. Amplify app **connected to GitHub** (CI deploys `main`). Cognito with the domain gate and `ADMIN` group. Schema with an explicit auth rule per model. **Vitest + CI running one test.** Config module for deployment-specific values. Design tokens chosen. Real source data in hand, and one real user spoken to. Live URL. |
| **2** | Ingestion: S3 → parse (adapter) → issues → dry-run diff → apply, **with fixture tests**. The core algorithm as a pure module **with table-driven tests**, wrapped in its Lambda. |
| **3** | The policy Lambda: `policy.cedar`, embedded engine, one `authorize()`, JSON decision logs, model read-only in AppSync, **a policy matrix test and an access-token-shaped handler test**. TTL. UI polish half-day. **Video script locked.** Demo accounts created. |
| **4** | Bug fixes only, from the testing checklist. README (credentials first, diagram, cost, services not used, test count), WRITEUP (problem, build, AWS, learned, honest limitations), CREDITS (incl. every AI tool). Record the video after two rehearsals. **Submit before the deadline; no commits after.** |

---

## 7. Paste this into the next project's CLAUDE.md

```markdown
## Carried over from Slate (see LESSON.md)
- Read LESSON.md before planning. It records what judges praised (AWS architecture, Cedar,
  server-derived identity, TTL, dry-run imports, explainable algorithms, cost discipline)
  and what cost us points (no tests; single-format coupling; late UI and video).
- Pre-approved dependencies: vitest, @cedar-policy/cedar-wasm, exceljs.
- Definition of done for any feature: pure logic in logic.ts → tests pass (npm test) →
  deployed via CI → verified on the live URL → commit → push.
- Never read identity, role, group or ownership from client arguments. Derive it from
  event.identity plus server lookups (AdminGetUser for email; access tokens have none).
- Every write that changes shared state goes through the policy Lambda. The model is
  read-only to users in AppSync. Log every decision as one JSON line.
- Deployment-specific values (email domains, ID formats, hours, time zone) live in config.
  External file formats live behind a SourceAdapter. The core only sees canonical rows.
- Serverless and scale-to-zero only (no EC2/NAT/RDS/OpenSearch/ECS/vector DB) unless asked.
  Use Query on GSIs, not Scan, on hot paths.
```
