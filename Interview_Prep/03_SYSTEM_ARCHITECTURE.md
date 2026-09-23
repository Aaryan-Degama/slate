# 03 — System Architecture

Everything below is read directly from `slate/amplify/` (the Amplify Gen 2 backend, defined entirely in TypeScript, deployed via `npx ampx sandbox` / Amplify Hosting CI) and `slate/amplify/backend.ts` (the CDK wiring). No service is claimed here that doesn't have a matching `resource.ts`/`backend.ts` line.

## High-level diagram (ASCII, matches the actual resource graph)

```
                                   ┌───────────────────────────┐
                                   │        Browser             │
                                   │  React + Vite (src/App.tsx)│
                                   └───────────┬────────────────┘
                                               │ static bundle
                                               ▼
                                   ┌───────────────────────────┐
                                   │      Amplify Hosting        │  <- public URL
                                   └───────────────────────────┘

  Browser ── sign in/up ──► Cognito User Pool (amplify/auth/resource.ts)
                             │  loginWith: email
                             │  custom:role attribute
                             │  ADMIN group (defineAuth groups:['ADMIN'])
                             │
                             └─ preSignUp trigger ──► Lambda: pre-sign-up
                                 (amplify/auth/pre-sign-up/handler.ts)
                                 rejects sign-up unless email ends @iiita.ac.in

  Browser ── GraphQL (userPool auth) ──► AppSync API (amplify/data/resource.ts)
                             │
                             ├─ model CRUD (typed, auto-generated resolvers) ──► DynamoDB tables:
                             │      User, TimetableSlot, ScheduleChange, ClassRep,
                             │      RollRange, StudentSection, Enrollment
                             │      (one table per @model, Amplify-managed)
                             │
                             ├─ custom query  findSlots        ──► Lambda: find-slots
                             ├─ custom query  parseTimetable   ──► Lambda: parse-timetable
                             ├─ custom mutation importData     ──► Lambda: import-data   (ADMIN group only)
                             └─ custom query/mutation ×6        ──► Lambda: section-changes
                                (mySection, batchRoster, claimCr, cancelOccurrence,
                                 addExtra, moveOccurrence, undoChange)

  Browser ── S3 PUT (ADMIN group only) ──► S3 bucket "timetableUploads"
                             (amplify/storage/resource.ts, prefix timetable-uploads/*)
                             read by: parse-timetable Lambda, import-data Lambda

  All five Lambdas ── console.log(JSON...) ──► CloudWatch Logs
    (structured lines: upload-parsed, import-checked/import-applied,
     slots-found, and the Cedar allow/deny line from section-changes)

  section-changes Lambda ── AdminGetUser ──► Cognito (verified email lookup)
    (access tokens carry no email claim; the Lambda is IAM-granted
     cognito-idp:AdminGetUser on the user pool)
```

## The pieces, one by one, with the actual file that defines each

### 1. Amplify Hosting — the public site

Serves the built React/Vite bundle (`npm run build` → `vite build`, output in `slate/dist/`). `amplify.yml` at the repo root is a build spec ready for Amplify's GitHub-connected CI to build both backend and frontend on push; in practice the team also used a manual deploy path (`slate/scripts/deploy-frontend.sh`). No server-side rendering, no Lambda@Edge — it's a static SPA behind Cognito's client-side Authenticator flow. Live URL is recorded in `README.md`.

### 2. Cognito — identity and the closed-community boundary

Defined in `amplify/auth/resource.ts`: `defineAuth({ loginWith: { email: true }, userAttributes: { 'custom:role': {...} }, groups: ['ADMIN'], triggers: { preSignUp } })`.

Two separate authorization concepts live here, deliberately kept apart:

- **Who can sign up at all** — the `preSignUp` Lambda trigger (`amplify/auth/pre-sign-up/handler.ts`) is the actual gate: `event.request.userAttributes.email.split('@')[1]` must equal `iiita.ac.in` or the trigger throws, which Cognito turns into a rejected sign-up. This is the *only* enforcement of "IIITA accounts only" — it's not client-side, it can't be bypassed by hitting the GraphQL API directly.
- **Who is an admin** — the `ADMIN` Cognito **group**, not the `User.role` field in DynamoDB. The code comment in both `auth/resource.ts` and `data/resource.ts` explains why: a signed-in user can edit their own `User` row (that's how a student links their section), but only an AWS-account-level action (`aws cognito-idp admin-add-user-to-group`) can add someone to a group. If admin rights were a DynamoDB field, any authenticated user could grant themselves admin through the same mutation that lets them set their own display name. `Role` is kept as a display-only enum (`STUDENT | FACULTY | ADMIN`) — real rights never come from it.

### 3. AppSync + DynamoDB — the data and API layer

`amplify/data/resource.ts` is the single schema file (`a.schema({...})`) that Amplify Gen 2 turns into an AppSync GraphQL API with one DynamoDB table per `@model`, auto-generated resolvers for standard CRUD, and custom Lambda-backed resolvers for anything that needs server logic. `defineData({ schema, authorizationModes: { defaultAuthorizationMode: 'userPool' } })` means every operation requires a valid Cognito user pool token by default — there is no anonymous/API-key path anywhere in this schema.

The seven `@model` tables, exactly as declared (see `docs/DATA-MODEL.md`... no — see the **actual** schema, since that doc describes an unbuilt future model):

| Model | Who can write | Who can read | Purpose |
|---|---|---|---|
| `User` | owner (self), read by anyone signed in | anyone signed in | profile: email, display role, `linkedSection` (their resolved section, cached client-side), `changesSeenAt` |
| `TimetableSlot` | `ADMIN` group only | anyone signed in | the regular, weekly, ingested timetable — the one source of truth for "what class happens when" |
| `ScheduleChange` | nobody directly (`allow.authenticated().to(['read'])` only) — all writes go through the `section-changes` Lambda, which uses IAM table grants, not the GraphQL auth rule | anyone signed in | one row per affected section per dated change; the only place "what changed" lives |
| `ClassRep` | read: anyone signed in; delete: `ADMIN` group (revoke); create goes through `section-changes` (IAM, not the model auth rule) | anyone signed in | one row per section that has a claimed CR |
| `RollRange` | `ADMIN` group | anyone signed in | roll-number → section fallback ranges, printed in the source sheets |
| `StudentSection` | `ADMIN` group only (no `allow.authenticated()` at all — students never read this table directly, they go through `mySection`/`batchRoster`) | `ADMIN` group only | per-student name/roll/section list, admin-uploaded — deliberately not student-readable, since it's a roster with other students' names |
| `Enrollment` | `ADMIN` group | `ADMIN` group | per-student exceptions to "you attend your home section's classes" (ADD/DROP), also not student-readable directly |

Custom operations, all schema-declared with `.handler(a.handler.function(...))`: `findSlots`, `mySection`, `batchRoster`, `claimCr`, `cancelOccurrence`, `addExtra`, `moveOccurrence`, `undoChange` (all on `authenticated()` — the *Cedar policy inside the Lambda*, not the GraphQL auth rule, is what actually decides who can do what for these), plus `parseTimetable` and `importData` (both restricted at the schema level to `ADMIN` group, belt-and-suspenders on top of the S3 bucket policy).

Two operational details worth citing because they show real production thinking, not just a schema dump:

- **DynamoDB TTL on `ScheduleChange`** — `backend.ts` sets `timeToLiveAttribute: { attributeName: 'expiresAt', enabled: true }` directly on the CDK-level table resource (`backend.data.resources.cfnResources.amplifyDynamoDbTables['ScheduleChange']`). Every row written by `section-changes/handler.ts` carries an `expiresAt` (epoch seconds, the Monday after the change's week) computed server-side; DynamoDB deletes expired rows automatically, at no read/write cost. This is how "only this week and next are ever shown" is actually enforced at the storage layer, not just filtered in the UI.
- **Pagination** — every `.list()` call in the frontend goes through `src/lib/listAll.ts`, which follows `nextToken` to the end (Amplify's default page size is 100; without this helper, larger batches would silently show partial data).

### 4. S3 — upload storage

`amplify/storage/resource.ts`: one bucket (`timetableUploads`), one prefix (`timetable-uploads/*`), access granted three ways — the `ADMIN` Cognito group gets read+write (the upload UI), and the `parse-timetable` and `import-data` Lambdas each get scoped read access via `allow.resource(fn).to(['read'])`. No public access, no anonymous access, nothing else in the bucket.

### 5. Lambda × 5 — the actual server logic

All defined the same Amplify Gen 2 way: a `resource.ts` (`defineFunction`) next to a `handler.ts`, wired into `data/resource.ts` as a custom operation's handler, and given table/bucket grants + environment variables explicitly in `backend.ts` (nothing is implicitly wide-open; every table a function touches is a named `grantReadData`/`grantReadWriteData` call).

1. **`pre-sign-up`** — the domain gate, described above (auth trigger, not a data-plane Lambda).
2. **`parse-timetable`** (`amplify/functions/parse-timetable/handler.ts`) — read-only. Loads an uploaded `.xlsx`/`.csv` from S3 (`load.ts`), classifies each sheet as a timetable (`reader.ts`: `readTemplate()` for Slate's own flat CSV format, or `processSheet()` for the messy real institute grid — reading merged-cell spans, two class-cell text formats, the course legend, and printed roll ranges) or a generic table (`table.ts`, used for student lists), and returns proposed rows + validation `issues` per sheet as JSON. Writes nothing.
3. **`import-data`** (`amplify/functions/import-data/handler.ts`) — the only Lambda that writes ingestion data, and it's ADMIN-gated at the handler level too (`if (!event.identity?.groups?.includes('ADMIN')) throw`, not just relying on the schema rule). Re-reads the same S3 file with the admin's confirmed column mapping, diffs against what's already in `TimetableSlot`/`StudentSection`/`RollRange` (added/changed/removed, by a computed natural key so re-uploads are idempotent), and only writes when `dryRun` is false. Logs a structured `import-checked`/`import-applied` line with who did it and what changed.
4. **`find-slots`** (`amplify/functions/find-slots/handler.ts`) — read-only, the slot-finding engine. Scans `TimetableSlot`, `ScheduleChange`, `StudentSection`, `RollRange`, `Enrollment`; builds a "busy interval" set per section, per course-professor, and per group of irregular attendees; generates every candidate contiguous time window across the requested dates (`candidates()`); intersects, ranks with explainable scoring, attaches a free room, and — if nothing survives — computes which single party's removal would unblock the most slots. Logs a `slots-found` structured line.
5. **`section-changes`** (`amplify/functions/section-changes/handler.ts`) — the only Lambda with real authorization logic, covering seven distinct GraphQL fields via one handler dispatching on `event.fieldName`. This is the piece worth explaining in depth (§6 below).

### 6. Cedar — real policy-as-code, not an `if` chain

`section-changes/handler.ts` imports `@cedar-policy/cedar-wasm/web`, loads a base64-embedded WASM module (`embedded.gen.ts`, generated so the Lambda bundle doesn't need a `.wasm` file on disk at runtime), and calls `isAuthorized({ principal, action, resource, policies: { staticPolicies: POLICY }, entities: [...] })` for every state-changing operation. The actual policy is a plain-text Cedar file, `amplify/functions/section-changes/policy.cedar`:

- `ClaimCr` — permit only if `principal.section == resource.key && !resource.hasCr`.
- `Cancel` / `AddExtra` / `Move` on a `Slate::Course` resource — permit only if `resource.crs.contains(principal)`, where `resource.crs` is a set of CR user-entities the server computed from `TimetableSlot` + `ClassRep`, not anything the client sent.
- `UndoGroup` — permit the original maker.
- `UndoSection` — permit that section's current CR, for undoing just their own section's part of a shared change.
- A blanket admin rule: `permit(principal, action, resource) when { principal.role == "ADMIN" }`.

Two things make this a genuine security boundary rather than security theatre: (1) every attribute Cedar evaluates — the principal's `section`, a course's `crs` set, a section's `hasCr`/`cr` — is derived server-side from `TimetableSlot`/`ClassRep`/a Cognito `AdminGetUser` lookup, never trusted from the mutation's arguments; (2) `authorize()` logs the decision (allow/deny), the action, the caller's email and the resource id as one JSON line to CloudWatch *before* throwing on deny, which is exactly the artifact the demo video shows on camera as proof of enforcement, not just a claim.

The caller's **verified** email is looked up via `AdminGetUserCommand` against the Cognito user pool (`USER_POOL_ID` env var, IAM-granted `cognito-idp:AdminGetUser` on the pool in `backend.ts`), because Slate authenticates with Cognito *access* tokens, which carry no email claim — a real, documented gotcha the team hit and fixed (commit `18115b7`, "Look up the caller's email in Cognito: access tokens don't carry it").

### 7. CloudWatch Logs — the observability story

No third-party logging, no OpenSearch. Every Lambda's `console.log(JSON.stringify({...}))` calls land in that function's own CloudWatch log group by default (Lambda's built-in behavior, nothing extra provisioned). The structured events that exist in code: `upload-parsed` (parse-timetable), `import-checked`/`import-applied` (import-data), `slots-found` (find-slots), and the unconditional Cedar `{cedar: 'allow'|'deny', action, email, principal, resource}` line from every `authorize()` call in section-changes. `docs/TESTING.md` includes the exact `aws logs tail ... | grep cedar` command used to verify this live.

### 8. What's explicitly absent (see `01_SLATE_REALITY_CHECK.md` for the full list)

No Textract, no live Bedrock call from any Lambda (the `scripts/bedrock-normalize-timetable.py` script exists with a real `boto3.client('bedrock-runtime').converse()` call and a genuine normalization prompt, but nothing in `amplify/functions/` imports or invokes it — Bedrock quota was 0 on the team's AWS account and couldn't be raised inside the event window, per `README.md`). No SES (explicitly dropped). No OpenSearch, RDS, NAT Gateway, ECS/Fargate, EKS, or EC2 anywhere in `backend.ts` — the cost guardrail in `CLAUDE.md` §3 held throughout the build.

## Cost shape

Every AWS resource in this architecture is either fully serverless-and-pay-per-request (AppSync, DynamoDB on-demand via Amplify's default table config, Lambda, S3, Cognito) or a static hosting bucket+CDN (Amplify Hosting). Nothing runs when idle; there is no fixed monthly floor. `README.md` states the team's actual development-time usage stayed under one US cent.
