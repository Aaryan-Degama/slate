# Kavyan's AWS guide — Slate critical path, zero to working

This assumes you've never touched AWS. Every section explains what the thing *is* before how to use it — you need to be able to explain these choices on camera and to a judge, so understand-first, copy-paste-second.

Reference: `CLAUDE.md` has the full spec, architecture table, data model and algorithm. This guide is the how-to for your slice of it (per `TEAM.md`): Cognito, the data schema, Textract/Bedrock ingestion, the slot-finding Lambda, Cedar, SES.

---

## Part 0 — What each piece actually is, in plain English

- **AWS account** — your top-level container for everything. Everything you create (a database, a function, an email sender) lives inside it and gets billed to it.
- **Region** — AWS runs in physical datacenter clusters around the world (e.g. `us-east-1` in Virginia, `ap-south-1` in Mumbai). You pick one region for your project; resources in different regions can't easily talk to each other. **Bedrock model access is approved per-region**, so this choice matters — see Part 1.
- **IAM** — AWS's permission system. "Can this piece of code call that service" is an IAM question. Amplify manages most of this for you automatically; you rarely write raw IAM policy by hand in this project.
- **Amplify (Gen 2)** — a framework that lets you *describe* your backend in TypeScript files (auth rules, data schema, functions) and it provisions the real AWS resources for you. This is why you're not clicking through the AWS Console by hand for most of this.
- **Cognito** — the authentication service. Handles signup, login, password reset, and can restrict who's allowed to sign up (your IIITA-only gate) and store custom fields on a user (your `role` attribute).
- **AppSync + DynamoDB** — your API and database. DynamoDB stores your data as JSON-like records (no SQL joins). AppSync is the API layer in front of it — Amplify generates this whole thing from one schema file you write.
- **Lambda** — a function that runs in the cloud on demand, with no server for you to manage. Your slot-finding algorithm and your ingestion pipeline are both Lambdas.
- **S3** — file storage. You'll use it to temporarily hold the AAA PDF files so Textract can read them.
- **Textract** — reads a document (PDF/image) and extracts text and table structure from it. This is how you turn a timetable PDF into rows and columns a program can use.
- **Bedrock** — access to foundation models (Claude, Titan, etc.) as an API call. You'll use it to clean up Textract's raw, messy extraction into your consistent data shape.
- **Cedar / Amazon Verified Permissions** — a way to write authorization rules ("only users with role=FACULTY can do X") as policy text, separate from your application code.
- **SES** — sends real emails from code.
- **CloudWatch** — where logs from everything above end up. This is where you'll screen-record proof that Bedrock/Textract actually ran, for the video.

---

## Part 1 — Account and environment setup

1. **Get your AWS account and credits.** Check your AWS Builder Center profile / hackathon dashboard for how the $3,000 credit is redeemed — usually a promo code applied to a personal AWS account, sometimes a provided sandbox account. Follow whatever the event email/dashboard says; don't guess this part, ask an organizer if it's unclear.
2. **Pick your region now, and don't change it later.** Check Bedrock model access first, since it's the most restrictive:
   - Go to the AWS Console → Bedrock → **Model access** (left sidebar) → request access to **Amazon Titan Text/Embeddings** models (and Claude if you want it for the normalization step) in your preferred region (try `ap-south-1` first for latency).
   - If access isn't grantable there, switch to `us-east-1` — it has the broadest model availability. Note this choice and why in your writeup (`CLAUDE.md` already flags this tradeoff).
3. **Install locally:**
   ```
   node --version   # need Node 18+
   npm install -g @aws-amplify/cli
   ```
4. **Configure AWS credentials locally** — Console → your username (top right) → Security credentials → create an access key, then:
   ```
   aws configure
   ```
   (installs the AWS CLI's credential file so Amplify can deploy on your behalf)

---

## Part 2 — Project setup

1. Clone the starter template (credited in `CREDITS.md`):
   ```
   git clone https://github.com/aws-samples/amplify-vite-react-template.git slate
   cd slate
   npm install
   ```
2. Start the Amplify **sandbox** — this deploys a real, personal, disposable copy of your backend to AWS for local development, without touching your production deployment:
   ```
   npx ampx sandbox
   ```
   Leave this running in a terminal while you work — it auto-redeploys when you save schema/auth/function files.

---

## Part 3 — Cognito: the IIITA gate and the role attribute

Open `amplify/auth/resource.ts`. This file *is* your Cognito configuration — Amplify turns it into a real user pool.

```typescript
import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: { email: true },
  userAttributes: {
    'custom:role': {
      dataType: 'String',
      mutable: true,
    },
  },
});
```

**The domain gate** — Cognito doesn't have a built-in "only allow this email domain" checkbox; you enforce it with a **pre-signup Lambda trigger**, a function that runs before Cognito approves any new signup and can reject it.

```typescript
// amplify/auth/pre-signup/handler.ts
import type { PreSignUpTriggerHandler } from 'aws-lambda';

export const handler: PreSignUpTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email;
  if (!email.endsWith('@iiita.ac.in')) {
    throw new Error('Only IIITA email addresses may register.');
  }
  return event;
};
```

Wire it into `defineAuth` with `triggers: { preSignUp: ... }` — Amplify's docs for `defineAuth` show the exact syntax; ask Claude Code to fill this in once you've written the handler logic yourself, since this is the closed-community boundary and worth understanding, not just having.

**Setting the role** — decide in your app: everyone signs up as `STUDENT` by default; you (the team) manually flip specific test accounts to `FACULTY` via the Cognito console for the demo, since there's no real faculty onboarding flow in scope.

---

## Part 4 — The data schema (AppSync + DynamoDB)

Open `amplify/data/resource.ts`. This one file generates your entire API and database. Translate `CLAUDE.md` §4 directly:

```typescript
import { a, defineData, type ClientSchema } from '@aws-amplify/backend';

const schema = a.schema({
  TimetableSlot: a.model({
    program: a.string(),
    branch: a.string(),
    section: a.string(),
    semester: a.string(),
    day: a.string(),
    startTime: a.string(),
    endTime: a.string(),
    courseId: a.string(),
    room: a.string(),
  }).authorization(allow => [allow.authenticated().to(['read'])]),

  SlotRequest: a.model({
    requesterId: a.string(),
    status: a.enum(['PROPOSED', 'CONFIRMED']),
    sections: a.json(),       // [{ program, branch, section }]
    constraints: a.json(),    // { earliestTime, latestTime, allowedDays, minDurationMins }
  }).authorization(allow => [allow.authenticated()]),

  ProposedSlot: a.model({
    requestId: a.string(),
    day: a.string(),
    startTime: a.string(),
    endTime: a.string(),
    room: a.string(),
    score: a.float(),
    reason: a.string(),
    blockingSection: a.string(),
  }).authorization(allow => [allow.authenticated()]),
});

export type Schema = ClientSchema<typeof schema>;
export const data = defineData({ schema });
```

Save it — the running sandbox redeploys automatically and generates a **typed client** (`amplify_outputs.json` + generated types) that Jalendu and Degama's frontend code imports directly. This is the artifact to share with them at the Day 1 sync point.

---

## Part 5 — Textract + Bedrock ingestion pipeline

**Do the gate test first, before writing the pipeline.** This decides whether ingestion is automated or hand-structured (per `CLAUDE.md` §6/§7).

### Gate test (do this today, manually, before automating anything)

1. Download 2–3 real AAA timetable PDFs.
2. In the AWS Console → Textract → try the demo/analyze-document tool, upload one PDF, choose **"Tables"** analysis (timetables are tabular data — this matters, plain text extraction loses the grid structure).
3. Look at the output. Can you tell which cell is which day/time/course? If yes, ingestion is viable. If it's a jumbled mess, plan to hand-structure that PDF's data instead (Degama's fallback job) and move on — don't sink hours fighting one bad PDF.

### The real pipeline, once the gate passes

1. **S3 bucket** — add Amplify storage (`amplify/storage/resource.ts`) to hold uploaded PDFs.
2. **Textract call** — timetable PDFs are usually multi-page, so use the **asynchronous** API:
   - `StartDocumentAnalysis` (pointing at the S3 object, `FeatureTypes: ['TABLES']`) kicks off a job and returns a job ID.
   - `GetDocumentAnalysis` (polled, or triggered by an SNS completion notification) returns the extracted tables once done.
3. **Bedrock normalization call** — Textract gives you raw table cells; different programs' PDFs are formatted inconsistently, so send Textract's raw output to Bedrock with a prompt like: *"Here is raw extracted table data from a college timetable. Convert it into this exact JSON shape: [{ day, startTime, endTime, courseId, room, section }]. Only output valid JSON."* — this is `InvokeModel` on Bedrock, a straightforward request/response call.
4. **Write to DynamoDB** — take Bedrock's structured JSON and create `TimetableSlot` records via the Amplify data client.

Do this as a **script you run manually** (a one-off Lambda you trigger yourself, or even a local Node script hitting the AWS SDK directly) — it's a per-semester batch job per `CLAUDE.md`, not something that needs a UI trigger.

**Get one real Textract call and one real Bedrock call working end to end before building anything else in this section — this is your gate, and it's also your Day 1 goal per `CLAUDE.md` §7.**

---

## Part 6 — The slot-finding Lambda (your algorithm)

This is the part you need to understand cold, not delegate. The logic, in plain terms (full detail in `CLAUDE.md` §5):

1. For each requested section, pull its `TimetableSlot` rows — these tell you when that section is *busy*. Free time is everything else in the week.
2. Represent each section's week as a list of busy `(day, start, end)` intervals. To find *common* free time across sections, you're computing where **none** of the sections have a busy interval — an interval intersection problem.
3. Filter what's left by the request's constraints (time window, allowed days, minimum duration).
4. If slots remain, score and rank them by the heuristics in `CLAUDE.md` §5 (avoid lunch, prefer daytime, avoid edge-of-day), then attach a free room if your timetable data includes room numbers.
5. If **nothing** remains, find which single section — if removed from the request — would unblock the most slots. That's your "blocking section" explanation.

Implement it as an Amplify **custom function** (`amplify/functions/find-slots/handler.ts`) wired as a custom query in your schema. Write step 2 (the actual intersection) yourself — ask Claude Code to review it for bugs and edge cases (e.g. overnight boundaries, overlapping-but-not-identical intervals) rather than write it from scratch, so you can explain exactly how it works when asked.

---

## Part 7 — Cedar authorization

Two honest paths, pick based on time remaining on Day 3:

**Path A — the real thing, if time allows.** Amazon Verified Permissions is the managed service that evaluates Cedar policies. You'd write a policy like *"a principal may perform action `ConfirmSlot` only if `principal.role == "FACULTY"`"*, create a Verified Permissions policy store, and have your Confirm & Notify Lambda call `IsAuthorized` before proceeding. This is genuinely worth doing if Day 3 has slack — it's a real, demonstrable use of a named AWS service from `CLAUDE.md` §3.

**Path B — the honest fallback.** If Day 3 is tight, gate the same check with Amplify's built-in authorization rule (`allow.authenticated().to(['read'])` plus a check on the `role` custom attribute in your Lambda/resolver code). Functionally identical outcome — only faculty can confirm — just not literally Cedar. **Say this plainly in the writeup if you take this path** — an honest "we planned Cedar, ran out of time, here's the equivalent check we shipped instead" reads far better than pretending you used a service you didn't.

Decide which path by end of Day 2 so you're not guessing on Day 3.

---

## Part 8 — SES notification

**The gotcha to know now:** new AWS accounts start SES in **sandbox mode**, meaning you can only send email to addresses you've individually verified in the SES console. For a hackathon demo this is fine — verify your own email and your teammates' emails (Console → SES → Verified identities → Create identity → enter email → click the confirmation link it sends you). Don't bother requesting production access; it takes days to approve and you don't need to email real strangers.

The call itself is a simple `SendEmail` API call from your Confirm & Notify Lambda, triggered once a `SlotRequest` status flips to `CONFIRMED`.

---

## Part 9 — Deploying for real (Amplify Hosting)

The sandbox (Part 2) is your personal dev copy. For the real public URL:

1. Push your repo to GitHub.
2. AWS Console → Amplify → **Host a web app** → connect your GitHub repo → pick the branch.
3. Amplify auto-detects the Vite/React build settings from the template; accept the defaults.
4. It builds and deploys automatically, and **redeploys on every push** — this is your CI, free, out of the box.
5. You get a public URL immediately (something like `https://main.xxxxx.amplifyapp.com`) — this is what goes in the video and README.

---

## Part 10 — Proving it for the video (CloudWatch)

- Console → CloudWatch → Log groups → find your Lambda's log group (named after the function) → open the latest log stream.
- Run your ingestion pipeline or slot-finding Lambda once, then find and screen-record the actual log line showing the Bedrock/Textract call completing. This satisfies the "must show AWS in the video" rule — a log line with a real timestamp and request ID is concrete proof, a screenshot of the Bedrock console is not as convincing.

---

## Order to actually do all this in (maps to `CLAUDE.md` §7)

1. Part 1–2: account, region, project setup
2. Part 3: Cognito + role attribute, deploy, confirm login works
3. Part 4: data schema, deploy, confirm typed client generates — **share with Jalendu/Degama now**
4. Part 5 gate test: Textract on a real PDF, decide automated vs. hand-structured
5. Part 5 full pipeline, if the gate passed
6. Part 6: the algorithm, tested by hand against real data
7. Part 7: Cedar or the fallback, decided by end of Day 2
8. Part 8: SES, verified identities set up early so it's not a Day 3 surprise
9. Part 9: hosting, live URL confirmed working
10. Part 10: grab your CloudWatch proof once everything above runs for real

Ask me to walk through any single part in more depth, or to start actually running these commands with you now.
