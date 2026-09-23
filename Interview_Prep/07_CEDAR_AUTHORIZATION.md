# 07 — Cedar Authorization in `section-changes`

## Real, running Cedar — not a description of a plan [VERIFIED-REPO]

`amplify/functions/section-changes/policy.cedar` is a real Cedar policy file,
evaluated at request time inside the `section-changes` Lambda via
`@cedar-policy/cedar-wasm` (the official WASM build of AWS's Cedar engine).
`git log` shows the policy was added and iterated across the pivot
(`291ead4 "Confirm through a Cedar policy in a Lambda"`,
`5eab6ee "Brief: changes reach the professor's sections, not the whole
course"`), and it's still the live authorization path for every write in the
app today — every CR claim, cancel, extra class, move, and undo goes through
`isAuthorized()` before touching DynamoDB.

## Why Cedar instead of hand-written `if` checks

Cedar is AWS's open-source policy language (also used internally by AWS
Verified Permissions). The alternative — scattering `if (caller.section ===
resource.section && !resource.hasCr)` checks through the handler — works, but
mixes "what the rule is" with "how the handler executes," making the rule
hard to audit or demo on its own. Cedar separates them: `policy.cedar` is a
short, declarative, independently readable statement of the rules; the
handler's only job is to correctly construct the `principal`/`resource`
entities Cedar reasons over. For a hackathon judged partly on "does
authorization actually work, shown on camera" (CLAUDE.md §8, showing an
allow *and* a deny in CloudWatch), having the policy as a standalone
artifact you can literally read out loud is a real advantage over five
`if` statements buried in application logic.

## Getting a `.cedar` file and a `.wasm` engine into a Lambda bundle

The Lambda bundler (esbuild, via Amplify's function build) can't import
`.wasm` or `.cedar` files directly. `section-changes/resource.ts` solves this
at **synth time**, before the handler is ever bundled:
```ts
// amplify/functions/section-changes/resource.ts
const wasm = createRequire(import.meta.url)
  .resolve('@cedar-policy/cedar-wasm/nodejs')
  .replace(/nodejs\/cedar_wasm\.js$/, 'web/cedar_wasm_bg.wasm')
writeFileSync(here('./embedded.gen.ts'),
  `export const POLICY = ${JSON.stringify(readFileSync(here('./policy.cedar'), 'utf8'))}\n` +
  `export const CEDAR_WASM_BASE64 = '${readFileSync(wasm).toString('base64')}'\n`
)
```
This generates `embedded.gen.ts` (gitignored, per the comment "do not edit")
containing the policy text as a string literal and the compiled WASM binary
base64-encoded as a string constant. The handler then does:
```ts
initSync({ module: Buffer.from(CEDAR_WASM_BASE64, 'base64') })
```
`initSync` is the WASM-web build's synchronous instantiation entry point —
needed because Lambda's Node runtime doesn't support top-level `await` for
async WASM instantiation the way a browser would; decoding a base64 string
back into bytes synchronously and initializing from that buffer sidesteps
the async-import problem entirely. This is a deliberate build-time
workaround for two real constraints (esbuild can't bundle `.wasm`/`.cedar`
natively, and Cedar's WASM engine needs to be embedded rather than fetched
at runtime) — worth being able to explain the "why," not just the "what," if
asked.

## The policy, rule by rule

```cedar
// Claim: your own section, and only while it has no CR.
permit (
  principal, action == Slate::Action::"ClaimCr", resource is Slate::Section
) when { principal.section == resource.key && !resource.hasCr };

// Cancel / add / move a course's class: the CR of any section taking it.
permit (
  principal, action in [Slate::Action::"Cancel", Slate::Action::"AddExtra", Slate::Action::"Move"],
  resource is Slate::Course
) when { resource.crs.contains(principal) };

// Undo a whole change: whoever made it.
permit (
  principal, action == Slate::Action::"UndoGroup", resource is Slate::Change
) when { resource.maker == principal };

// Undo a change for one section only: that section's CR.
permit (
  principal, action == Slate::Action::"UndoSection", resource is Slate::Section
) when { resource.hasCr && resource.cr == principal };

// Admins can do all of it.
permit (principal, action, resource) when { principal.role == "ADMIN" };
```
Five `permit` statements, no `forbid` — Cedar's default is deny, so anything
not explicitly permitted (a non-CR trying to cancel a class, a CR of Batch
A's section acting on Batch B's course) is denied automatically, which is
exactly the demo moment CLAUDE.md §8 calls for ("A non-CR trying the same is
denied: show the Cedar deny line in CloudWatch").

Note the entity types are namespaced (`Slate::Action`, `Slate::Section`,
`Slate::Course`, `Slate::Change`) and the last rule's `resource` has no `is`
type restriction at all — an admin's catch-all applies to any resource type
the handler ever constructs, so a new action added later is automatically
admin-accessible without touching the policy.

## The critical property: the server derives every attribute Cedar reasons over

Cedar itself doesn't "trust" anything — it evaluates whatever entity
attributes it's handed. The security guarantee comes entirely from
**where those attributes come from** in `handler.ts`, and the design here is
explicit that none of them are client-supplied:

```ts
async function sectionOf(email: string): Promise<Section | null> {
  const r = await resolve(email)   // homeOf(email, students, ranges) — StudentSection/RollRange scan
  return r && { program: r.program, branch: r.branch, semester: r.semester, section: r.section }
}
```
`principal.section` comes from `resolve(email)` → `homeOf()` (shared with
`find-slots`, see 05/06) — a lookup against admin-uploaded `StudentSection`
and `RollRange` tables, keyed by the caller's **verified** email (see 04 for
why that requires an explicit `AdminGetUser` Cognito call rather than
trusting a token claim). A student cannot claim to be in a section they
aren't; the section comes from institutional data, not the request payload.

```ts
const courseEntity = (ctx: Ctx, batch: Batch, courseId: string, rows: Row[]): Entity => {
  const keys = new Set(rows.map(keyOf))
  const crs = ctx.reps.filter((r) => keys.has(String(r.sectionKey))).map((r) => ({ __entity: user(String(r.sub)) }))
  return { uid: { type: 'Slate::Course', id: `${batchKey(batch)}|${courseId}` }, attrs: { crs }, parents: [] }
}
```
`resource.crs` (the set of CRs allowed to act on a course) is built from
`TimetableSlot` rows the server itself queried for that course/batch,
cross-referenced with the live `ClassRep` table — never from a list of
sections the client claims the course has. This is the literal
implementation of the invariant stated in CLAUDE.md §4: *"The server always
recomputes the affected sections from `TimetableSlot` and never trusts a
section list sent by the client."* The `addExtra` handler goes further,
narrowing `courseRows` to only the sections the CR's own professor teaches
*before* constructing the Cedar resource, so even a legitimate CR can't
extend their authority to sections a different professor teaches for the
same course code:
```ts
if (ctx.mine) {
  const profs = new Set(courseRows.filter((r) => keyOf(r) === keyOf(ctx.mine!) && r.faculty).map((r) => r.faculty))
  if (profs.size) courseRows = courseRows.filter((r) => profs.has(r.faculty))
}
```

## Two-tier undo authorization

`undoChange` tries `UndoGroup` (the original maker) first; on a Cedar denial
(caught, not re-thrown) it falls back to `UndoSection`, letting *a CR of an
affected section* undo the change just for their own section:
```ts
try {
  authorize(ctx, 'UndoGroup', maker, 'denied')
} catch {
  if (!ctx.mine) throw new Error('...')
  const key = keyOf(ctx.mine)
  targets = rows.filter((r) => keyOf(r) === key)
  if (!targets.length) throw new Error('This change doesn't affect your section.')
  authorize(ctx, 'UndoSection', sectionEntity(ctx, key), '...')
}
```
This is the code-level realization of the product rule in CLAUDE.md §2:
"one CR decides for the course; others can undo for their own section." Two
separate Cedar actions, evaluated in sequence, rather than one combined rule
— keeps each policy statement about one clean condition (maker-equality vs
section-CR-equality).

## Every decision is logged

```ts
function authorize(ctx: Ctx, action: string, resource: Entity, denied: string) {
  const answer = isAuthorized({ principal: ctx.principal.uid, action: {...}, resource: resource.uid,
    context: {}, policies: { staticPolicies: POLICY }, entities: [ctx.principal, resource] })
  if (answer.type === 'failure') throw new Error(`Cedar error: ...`)
  const decision = answer.response.decision
  console.log(JSON.stringify({ cedar: decision, action, email: ctx.email, principal: ctx.principal.attrs, resource: resource.uid.id }))
  if (decision !== 'allow') throw new Error(denied)
}
```
Every single authorization check — allow or deny — logs a structured line to
CloudWatch with the decision, the action, the caller's email, their derived
principal attributes, and the resource id. This is the literal artifact the
demo video shows on camera (CLAUDE.md §8: "show the Cedar deny line in
CloudWatch") and matches CLAUDE.md §3's stated requirement: "Every decision
is logged to CloudWatch."

## `Slate::Action::"..."` string IDs vs. a Cedar schema file

There's no separate Cedar *schema* file (`.cedarschema`) validating entity
shapes — the policy and the handler agree on entity type/attribute names by
convention (`Slate::Section` always has `key`/`hasCr`/`cr`; `Slate::Course`
always has `crs`), checked only at runtime by Cedar's evaluator, not
statically. For a project this size that's a reasonable simplification —
adding schema validation would catch a typo'd attribute name earlier, at the
cost of another artifact to keep in sync — but worth naming as a known gap
if asked, per the project's own norm of being upfront about what wasn't
built.

---

## Q&A

**Q: Why Cedar instead of just writing the checks as `if` statements in the handler?**
Auditability and demo-ability: the whole authorization model is one small,
declarative file that can be read and reasoned about independently of the
handler's control flow, and every check funnels through one `authorize()`
call that logs uniformly. Functionally it's equivalent to well-written `if`
statements, but Cedar makes "what is the rule" a first-class, inspectable
artifact rather than something you have to reconstruct by reading branches.

**Q: How do you actually get a WASM Cedar engine running inside a Lambda?**
At CDK synth time (`resource.ts`), before the handler is bundled: resolve
the installed `@cedar-policy/cedar-wasm` package's `.wasm` binary path,
read it and the `policy.cedar` text into memory, and write both out as
base64/string literals in a generated `embedded.gen.ts` module. The handler
then calls `initSync(Buffer.from(CEDAR_WASM_BASE64, 'base64'))` to
instantiate the engine synchronously from that in-memory buffer — avoiding
both the bundler's inability to import `.wasm`/`.cedar` files and the
async-instantiation problem WASM normally has in Node.

**Q: How does the server stop a student from just claiming to be a CR or in a different section?**
It never reads section/CR claims from the request. `principal.section` is
derived by looking up the caller's Cognito-*verified* email (fetched via an
authenticated `AdminGetUser` call, not a token claim — see 04) against
admin-uploaded `StudentSection`/`RollRange` data. `resource.crs` for a course
is built by querying `TimetableSlot` for that course/batch and
cross-referencing the live `ClassRep` table server-side. There is no field
in any mutation's arguments that lets a client assert its own section or CR
status.

**Q: What happens on a Cedar deny?**
`isAuthorized()` returns `{ decision: 'deny' }` (not a thrown error — Cedar
itself never throws for a normal deny, only `answer.type === 'failure'`
indicates a genuine evaluation error like a malformed policy). The
`authorize()` wrapper logs the deny, then throws a caller-supplied,
human-readable error message (e.g. "Only the CR of a section in this class
can cancel it.") back through the Lambda resolver to the client.

**Q: Is there a Cedar schema (`.cedarschema`) validating entity attribute types?**
No — confirmed by `search_files`/directory listing: only `policy.cedar`
exists, no schema file. Entity shape agreement between the policy and the
handler is by convention, checked only at evaluation time. A reasonable
simplification at this scale, but a real gap versus a fully schema-validated
Cedar setup.
