# 04 — AWS Amplify Gen 2, Cognito, and Hosting

## What's actually deployed [VERIFIED-REPO]

Slate has no hand-provisioned infrastructure. Everything — Cognito user pool,
AppSync GraphQL API, five DynamoDB tables, four Lambdas, one S3 bucket — comes
from a single call:

```ts
// slate/amplify/backend.ts
const backend = defineBackend({
  auth,
  data,
  storage,
  parseTimetable,
  importData,
  findSlots,
  sectionChanges,
});
```

This is Amplify Gen 2: infrastructure as TypeScript CDK constructs, synthesized
by `ampx` (the Amplify CLI) into a CloudFormation stack per environment
("sandbox" for local dev, a named branch stack for the deployed app). There is
no `amplify push` YAML config from Gen 1 — every resource is a typed object
imported into `backend.ts`, and cross-resource wiring (grants, env vars) is
plain CDK calls on `backend.<name>.resources`.

## Auth: the domain gate, not a role field

```ts
// slate/amplify/auth/resource.ts
export const auth = defineAuth({
  loginWith: { email: true },
  userAttributes: {
    'custom:role': { dataType: 'String', mutable: true },
  },
  groups: ['ADMIN'],
  triggers: { preSignUp },
});
```

Two things do the actual authorization work here, and neither is the
`custom:role` attribute:

1. **The pre-sign-up Lambda trigger** is the closed-community boundary:

```ts
// slate/amplify/auth/pre-sign-up/handler.ts
const ALLOWED_DOMAIN = 'iiita.ac.in';
export const handler: PreSignUpTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email ?? '';
  const domain = email.split('@')[1]?.toLowerCase();
  if (domain !== ALLOWED_DOMAIN) {
    throw new Error(`Sign-up is restricted to @${ALLOWED_DOMAIN} email addresses.`);
  }
  return event;
};
```
   Cognito calls this synchronously during `SignUp`; throwing aborts the
   sign-up before a user record is even created. This is the entire "closed
   community" feature — nobody outside `@iiita.ac.in` can ever get an account,
   full stop, regardless of anything the client sends.

2. **The `ADMIN` Cognito group** is the only source of admin rights. `User.role`
   (`STUDENT | FACULTY | ADMIN`, a schema enum in `data/resource.ts`) is
   explicitly commented as **display-only** — a user can edit their own `User`
   row (`allow.owner()`), so trusting `role` for authorization would let anyone
   self-promote. Every real admin check in the codebase reads Cognito group
   membership instead:
   - Schema-level: `TimetableSlot`, `RollRange`, `StudentSection`, `parseTimetable`,
     `importData` all use `allow.group('ADMIN')`.
   - Lambda-level: `import-data/handler.ts` line 99 — `if
     (!event.identity?.groups?.includes('ADMIN')) throw new Error(...)`.
   - Cedar-level: `policy.cedar`'s catch-all `permit (...) when { principal.role
     == "ADMIN" }`, where `principal.role` is derived server-side from the
     identity's Cognito groups (`section-changes/handler.ts`, `roleOf`), never
     from the client or the `User` table.

   Only an operator with AWS console/CLI access can add a user to `ADMIN` —
   there's no self-service "become admin" path, by design.

### Why access tokens, not ID tokens, and why that needs a Cognito lookup

The app authenticates AppSync calls with Cognito **access** tokens. Access
tokens carry `sub` and group membership but not custom attributes like email.
`section-changes/handler.ts` needs the caller's *verified* email to resolve
their section (`resolveSectionFromEmail`), so it can't trust anything the
client claims. Its `emailOf()` calls `AdminGetUserCommand` against the user
pool directly:

```ts
// amplify/functions/section-changes/handler.ts
async function emailOf(identity: Identity): Promise<string> {
  if (identity.claims?.email) return identity.claims.email
  const username = identity.username ?? identity.sub
  ...
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: ..., Username: username }))
  const attr = (n: string) => user.UserAttributes?.find((x) => x.Name === n)?.Value
  emails.set(username, attr('email_verified') === 'true' ? (attr('email') ?? '') : '')
}
```
Note it also checks `email_verified === 'true'` — an unverified email address
is treated as no email at all, so a CR claim or a change can never be attached
to a spoofable address. `backend.ts` wires the two things this needs:
```ts
backend.sectionChanges.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId);
backend.auth.resources.userPool.grant(changesFn, 'cognito-idp:AdminGetUser');
```
`AdminGetUser` is an IAM-permissioned admin API, callable only by a
principal the pool trusts (here, the Lambda's execution role) — not by end
users, which is exactly the trust boundary needed.

## Data layer: AppSync + DynamoDB, generated

```ts
// amplify/data/resource.ts
export const data = defineData({
  schema,
  authorizationModes: { defaultAuthorizationMode: 'userPool' },
});
```

`a.schema({...})` declares models (`User`, `TimetableSlot`, `ScheduleChange`,
`ClassRep`, `RollRange`, `StudentSection`, `Enrollment`) and custom
query/mutation fields backed by Lambda resolvers (`findSlots`, `mySection`,
`batchRoster`, `claimCr`, `cancelOccurrence`, `addExtra`, `moveOccurrence`,
`undoChange`, `parseTimetable`, `importData`). Amplify turns this into an
AppSync GraphQL API with one DynamoDB table per `.model()`, a generated
TypeScript client (`generateClient<Schema>()`), and Cognito-userPool-based
`@aws_auth` directives from each model's `.authorization()` chain — there is
no hand-written resolver VTL/JS or REST layer for the model CRUD paths.

`defaultAuthorizationMode: 'userPool'` means every field requires a signed-in
Cognito user unless a field's own `.authorization()` narrows or widens that
(e.g. `parseTimetable`/`importData` narrow to `allow.group('ADMIN')`).

Every custom field routes to one of four Lambdas via
`.handler(a.handler.function(fn))` — this is a "direct Lambda resolver": no
VTL mapping template, AppSync just invokes the function with
`{ fieldName, arguments, identity }` and returns its JSON output as-is (the
handlers return `JSON.stringify(...)` because the field's return type is
`a.json()`).

## Wiring cross-stack IAM by hand in `backend.ts`

Amplify Gen 2 doesn't auto-grant a Lambda access to a table just because it's
in the same schema — `backend.ts` does this explicitly per model, per
function, matching least privilege to what that Lambda actually does:

```ts
const tables = backend.data.resources.tables;
const importFn = backend.importData.resources.lambda;
for (const [model, env] of [
  ['TimetableSlot', 'TIMETABLE_SLOT_TABLE'],
  ['StudentSection', 'STUDENT_SECTION_TABLE'],
  ['RollRange', 'ROLL_RANGE_TABLE'],
] as const) {
  tables[model].grantReadWriteData(importFn);
  backend.importData.addEnvironment(env, tables[model].tableName);
}
```
`find-slots` gets `grantReadData` only (it only ever scans); `section-changes`
gets `grantReadWriteData` on `ScheduleChange`/`ClassRep` but `grantReadData`
only on `TimetableSlot`/`StudentSection`/`RollRange`/`Enrollment` — it must
never be able to alter the ingested timetable or roster, only the change log
and CR claims. `grantReadWriteData`/`grantReadData` are CDK convenience
methods on the underlying `dynamodb.Table` construct that generate the
correctly-scoped IAM policy statements (`dynamodb:GetItem`, `Query`, `Scan`,
`PutItem`, etc. as appropriate) — this is standard CDK, exposed by Amplify
because `backend.data.resources.tables` hands back real CDK `Table` objects,
not an opaque abstraction.

`resourceGroupName: 'data'` on each function (`find-slots/resource.ts`,
`section-changes/resource.ts`) puts the Lambda in the same CloudFormation
nested stack as the data resources — the comment in the code says why:
"avoids a dependency cycle" (the data schema's fields reference the function,
and the function needs table names/ARNs the data stack creates — putting them
in one stack breaks the circular cross-stack reference CloudFormation would
otherwise reject).

## TTL wired at the CDK level

```ts
backend.data.resources.cfnResources.amplifyDynamoDbTables['ScheduleChange']
  .timeToLiveAttribute = { attributeName: 'expiresAt', enabled: true };
```
This drops to the raw L1 CloudFormation resource (`cfnResources`) because
`a.model()` has no schema-level DSL for TTL — it's a DynamoDB table setting,
not a GraphQL concept, so Amplify Gen 2 deliberately leaves an escape hatch to
the underlying `AWS::DynamoDB::Table` properties rather than inventing a
parallel abstraction. See 05 for what this buys.

## Storage: one bucket, two Lambda readers, one human writer

```ts
// amplify/storage/resource.ts
export const storage = defineStorage({
  name: 'timetableUploads',
  access: (allow) => ({
    'timetable-uploads/*': [
      allow.groups(['ADMIN']).to(['read', 'write']),
      allow.resource(parseTimetable).to(['read']),
      allow.resource(importData).to(['read']),
    ],
  }),
});
```
`allow.resource(fn)` is Amplify's syntax for granting a *Lambda* (not a user
role) S3 permissions — it becomes an IAM policy on that function's execution
role, scoped to the `timetable-uploads/*` prefix, nothing else in the bucket.
Only the ADMIN group can ever write into this prefix from the client; the two
ingestion Lambdas can only read what's already there. There is no public or
unauthenticated access to this bucket at all.

## Hosting and deploy flow — no CI/CD wired up

The `README.md`'s architecture table cites Amplify Hosting with "CI from
GitHub" as the plan, but the actual deploy script in the repo
(`scripts/deploy-frontend.sh`) is a **manual** zip-upload flow, not a Git-
triggered build:

```bash
APP_ID=${APP_ID:-d1hpc7rjskshni}
BRANCH=${BRANCH:-main}
npm run build
ZIP=$(mktemp -d)/site.zip
(cd dist && zip -qr "$ZIP" .)
read -r JOB URL < <(aws amplify create-deployment ... --query "[jobId,zipUploadUrl]" --output text)
curl -sf -X PUT -H "Content-Type: application/zip" --data-binary @"$ZIP" "$URL"
aws amplify start-deployment ... --job-id "$JOB"
```
This uses the `aws amplify create-deployment` / `start-deployment` API pair —
Amplify Hosting's manual-deploy path, normally exposed as drag-and-drop in the
console, driven here from the CLI for reproducibility. It polls
`get-job` until `SUCCEED`/`FAILED`. The public URL is
`https://main.d1hpc7rjskshni.amplifyapp.com`, a static Amplify Hosting
subdomain (CloudFront + S3 under the hood, managed entirely by the Amplify
service). Backend changes are deployed separately with `npx ampx sandbox
--once` (per `docs/PLAN.md`), which synthesizes and deploys the CDK stack
without hosting the frontend.

**Honest gap:** so the *backend* (Amplify Gen 2 CDK stack: Cognito, AppSync,
DynamoDB, Lambdas) is genuinely IaC and reproducible from `amplify/`, but the
*frontend hosting* is a manual authenticated zip push, not the "CI from
GitHub" the README's stack table describes as the plan. Worth saying plainly
if asked in an interview — matches CLAUDE.md's own instruction not to claim a
feature that isn't actually wired up.

## Cost model: why nothing else is in the stack

Every service above is pay-per-use with a real zero floor:
- **Cognito**: free tier covers thousands of MAUs; no idle cost.
- **AppSync**: billed per request/data resolved; nothing running when nobody calls it.
- **DynamoDB**: on-demand billing (Amplify's default table mode) — no
  provisioned capacity to pay for at rest, and the `ScheduleChange` TTL
  deletes stale items for free (TTL deletes don't consume write capacity).
- **Lambda**: billed per invocation/ms; `find-slots` and `section-changes` are
  `timeoutSeconds: 30`, no long-running compute.
- **S3 + Amplify Hosting**: pennies per GB stored/served.

None of RDS, ECS/Fargate, EKS, EC2, NAT Gateway, or OpenSearch appear anywhere
in `backend.ts` — confirmed by grep, not just by the brief's stated intent.
There's no VPC at all, so there's no NAT Gateway to avoid paying for in the
first place: every Lambda here talks to DynamoDB, Cognito and S3 over AWS's
public/PrivateLink-backed service endpoints, needing no VPC attachment. That
absence is itself a design decision, not an oversight: nothing in this app
needs a VPC-only resource (no RDS, no internal service mesh), so adding one
would only add NAT costs and cold-start latency for zero benefit.

---

## Q&A

**Q: Why gate signup with a Lambda trigger instead of Cognito's built-in email domain restrictions?**
Cognito has no native "restrict sign-up to this domain" setting for
email/password pools — that requires either a custom Lambda trigger
(`preSignUp`) or a SAML/OIDC federation restricted to an IdP scoped to the
domain. A Lambda trigger is the lighter-weight choice for a single hackathon
university domain, and it's easy to audit: one file, one string comparison,
throws to reject.

**Q: Why not just use `User.role` for authorization since it's already in the schema?**
Because `User` allows `allow.owner()` — the row's owner (the user themselves)
can update it, including `role`. If any authorization check trusted
`User.role`, a student could `updateUser({ role: 'ADMIN' })` from the client
and self-promote. Cognito group membership can only be changed by an IAM
principal with `cognito-idp:AdminAddUserToGroup`, which end users never have.
`role` stays as a display-only convenience field.

**Q: How does a Lambda resolver differ from a VTL resolver, and why use it here?**
A VTL (or JS) resolver runs a mapping template inside AppSync that
constructs a DynamoDB request directly, with no compute step. A Lambda
resolver hands the whole `{fieldName, arguments, identity}` payload to a
function and returns whatever JSON it produces. Slate's custom fields (Cedar
authorization, cross-table scans, interval-intersection math) need real
compute and multiple table reads that a VTL template can't express — direct
Lambda resolvers are the natural fit, at the cost of a small per-invocation
Lambda cold-start versus a VTL resolver's near-zero overhead.

**Q: What happens if the pre-sign-up Lambda throws?**
Cognito surfaces the thrown error to the client as the sign-up failure
reason and never creates a user pool entry — so an `@gmail.com` address
never even gets as far as "unconfirmed user," it's rejected at the API call
that would have created the account.

**Q: Is the "CI from GitHub" claim in the architecture table accurate?**
No — verified against `scripts/deploy-frontend.sh`, which is a manual
authenticated `zip` upload via the AWS CLI, run by a human, not a
GitHub-triggered Amplify Hosting build. The backend is genuinely IaC via
`ampx sandbox`, but hosting isn't Git-connected in this repo as shipped.
