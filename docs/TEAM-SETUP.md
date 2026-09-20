# Working on Slate with someone else

The backend currently running is a **personal sandbox**: `amplify-slate-kavyan2-sandbox-8135cfd1ea` in `ap-south-1`, deployed from one machine. It holds all the real data (students, timetables, registrations). The live site is Amplify app `dosqfo1xoqa7l` → <https://main.dosqfo1xoqa7l.amplifyapp.com>.

There are two ways to share it. Start with A (nothing to re-import); move to B when there's time.

---

## A. Share the sandbox that already has the data

Your friend runs the **frontend locally against the same backend**, so they see the same students, timetables and registrations. Only one person deploys the backend.

### 1. Give them AWS access (you, once)

In the AWS console, **IAM Identity Center → Users → Add user**, then assign them a permission set for this account. `PowerUserAccess` is enough and, unlike an IAM user with access keys, gives them their own short-lived credentials.

Do **not** share your `slate` profile's keys: if they leak, anyone can spend on your account and you can't tell who did what.

### 2. They set up the repo (them, once)

```bash
git clone https://github.com/kavyan256/slate.git && cd slate/slate
npm ci
aws configure sso            # profile name: slate, region: ap-south-1
```

### 3. They point at the shared backend (them, whenever it changes)

```bash
npx ampx generate outputs \
  --stack amplify-slate-kavyan2-sandbox-8135cfd1ea \
  --profile slate --region ap-south-1
npm run dev
```

`amplify_outputs.json` is gitignored, which is why each person generates their own. Their local frontend now talks to the shared API, Cognito pool and data.

### 4. Who does what

| Task | Who |
|---|---|
| Frontend work (`src/`) | either, locally, against the shared backend |
| Backend changes (`amplify/`) | **one person** runs `ampx sandbox`, or the change gets deployed by whoever owns the sandbox |
| Publishing the site | `scripts/deploy-frontend.sh` (needs `amplify:CreateDeployment`) |

If they want to experiment with `amplify/` themselves, they can run their own sandbox — but it creates a **separate, empty** backend, and the data would have to be re-imported there.

### On the campus network

Both of you need the proxy wrapper, or deploys hang with `ETIMEDOUT`:

```bash
NODE_OPTIONS="--require $PWD/scripts/force-proxy.cjs" npx ampx sandbox --once
```

---

## B. A proper shared deployment (do this when there's time)

Connect the GitHub repo to Amplify Hosting (console → app `slate` → connect branch `main`). After that, merging to `main` builds and deploys both the backend and the site, and nobody needs deploy credentials.

- Everyone gets outputs with `npx ampx generate outputs --app-id dosqfo1xoqa7l --branch main --profile slate`.
- The trade-off: it creates a **new backend**, so the data is imported once more through the admin screens (timetables, the four student lists, then the registration list — about ten minutes).
- Pull requests get their own preview backends, which is the usual way two people work without treading on each other.

---

## Splitting the work

`docs/PLAN.md` has the phases and `docs/DATA-MODEL.md` the target model. The clean split right now:

- **Admin/ingestion** (`amplify/functions/import-data`, `parse-timetable`, `src/Admin*`) — finishing the registration import UI, the institute-wide courses that don't match a timetable.
- **Student/CR** (`src/StudentDashboard.tsx`, `NewRequest.tsx`, `section-changes`) — the week view, changes, the finder.

They barely overlap, so two people can work without conflicts. Branch per task, PR into `main`.
