# 09 — Frontend (React + Vite + TypeScript)

Everything below is read from `slate/src/` directly. Component names, file paths and function names are exact.

## Stack and build

- **React 19.2** + **Vite 8** + **TypeScript**, `npm run build` = `tsc -b && vite build` (a real typecheck gate, not just a bundle step — `tsc -b` fails the build on type errors before Vite even runs).
- **`@aws-amplify/ui-react`**'s `Authenticator` component handles the entire sign-in/sign-up/reset UI — Slate never hand-rolls a login form. It's reskinned via a Theme object (`amplifyTheme` in `App.tsx`) that overrides fonts, radii and colors to match Slate's own teal design tokens (`index.css`), but the actual auth flow (password rules, verification codes, error states) is 100% Amplify UI's, unmodified.
- No router library. Navigation is plain `useState` tab switching (`studentTab`/`adminTab` in `App.tsx`), because the whole app is two flat tab bars — a router would be over-engineering for five student screens and seven admin screens with no deep-linkable URLs required.
- No global state manager (no Redux/Zustand/Context-as-store). State lives in whichever component owns a screen, fetched fresh with `useEffect` + the generated Amplify Data client. This is a deliberate, consistent pattern across every screen file, not an oversight — see "Data fetching pattern" below.
- `.oxlintrc.json` + `oxlint` for linting (a fast Rust-based ESLint alternative), run via `npm run lint`.

## Entry point and the auth/profile bootstrap

`main.tsx` imports `amplifyConfig.ts` *before* `App`, with a comment explaining exactly why: ES modules evaluate dependency-first, so `Amplify.configure(outputs)` must run before any top-level `generateClient()` call anywhere in the component tree (several files call `generateClient<Schema>()` at module scope, not inside a component). Getting this file ordering wrong is a real, documented bug class in Amplify Gen 2 apps; `amplifyConfig.ts` exists specifically to sidestep it.

`App.tsx`'s top level renders `ThemeProvider > Authenticator.Provider > AuthGate`. `AuthGate` uses `useAuthenticator` to check `authStatus`: unauthenticated renders `AuthShell` (a marketing-style split screen — problem statement on the left, the Amplify `Authenticator` form on the right) wrapping the sign-in form; authenticated renders `Authenticator` again (needed to get `user`/`signOut` from render props) which mounts `SignedIn`.

`SignedIn` is where the app really starts. It's keyed by `user.userId` (`key={user.userId}`) specifically so switching accounts forces a full remount rather than reusing stale state from a previous login. It calls two custom hooks:

- **`useMyProfile(userId)`** (`src/lib/useMyProfile.ts`) — finds the caller's own `User` row by filtering all readable `User` rows on `owner === userId` client-side (every signed-in user can read all `User` rows per the schema's authorization rule; ownership is enforced by which row you're allowed to *write*, and the app narrows to "mine" itself). If no row exists yet, it creates one (`role: 'STUDENT'` always — nobody can self-assign `ADMIN` through this path since admin comes from the Cognito group, not this field). It hand-serializes `linkedSection` to/from JSON because it's an `a.json()` (AWSJSON) field, and AWSJSON travels over the wire as a raw string — the file has an explicit comment explaining that the manually-cast query bypasses the generated client's usual auto-(de)serialization, so this is done by hand at both read and write.
- **`useClassReps()`** (`src/lib/classReps.ts`) — loads every `ClassRep` row so `App.tsx` can compute `isCr = reps.some(r => r.sub === userId)` and decide whether to show the "Make a change" tab at all.

`App.tsx` then branches on `profile.role === 'ADMIN'` for a completely separate admin shell/nav, or falls into the student/CR shell otherwise — there is no third branch; `FACULTY` is a dead enum value that never routes anywhere (see the reality-check doc).

## Screen inventory (student side)

| File | Route (tab) | Responsibility |
|---|---|---|
| `StudentDashboard.tsx` | "My Timetable" | The core screen. Resolves the student's section (see below), renders the current week's effective timetable via `TimetableGrid`, the "What changed" feed, the CR status bar, and — if the viewer is a CR — inline panels for Cancel/Extra/Move triggered by clicking cells. |
| `MyBatch.tsx` | "My Batch" | Fetches `fetchBatchRoster()` (wraps the `batchRoster` query) and renders the same `StudentTable` component the admin uses, scoped server-side to the caller's own batch. |
| `NewRequest.tsx` | "Make a change" (CR only) | Course/section picker → date/time constraints → calls the `findSlots` query → ranked results with a live preview grid → save (`addExtra`/`moveOccurrence`). |

Section resolution is worth detailing because it's the thing most screens depend on. `StudentDashboard`'s top-level component tries `resolveSectionFromEmail(profile.email)` (really a thin wrapper around the `mySection` server query — despite the name it ignores the email argument client-side and trusts the server's own verified-email lookup) on mount if `profile.linkedSection` isn't already cached. If the server can resolve a section from the roll number, it's saved onto the `User` row via `linkSection()`; if not, `SectionPicker` lets the student manually pick from every distinct `(program, branch, section, semester)` combination seen in `TimetableSlot` — explicitly described in the UI copy as "this links your login, it doesn't create any data," and the server independently re-derives the real section for anything authorization-sensitive (CR claims, roster access), so a self-picked wrong section can't be used to claim someone else's CR seat.

## Screen inventory (admin side)

| File | Responsibility |
|---|---|
| `AdminDashboard.tsx` | Summary stats (rows/semesters/courses/faculty count) over ingested `TimetableSlot` data, plus a "gap detector": scans for sections that split into sub-sections (`B1`/`B2`) in the real timetable data but have no `RollRange`/`StudentSection` row covering that exact sub-section, and prompts the admin to fix it. |
| `AdminUpload.tsx` | The S3-upload → `parseTimetable` → review → `importData` flow described in the architecture doc. Delegates to `StudentImport.tsx` for the student-list branch of the same upload. |
| `AdminStudents.tsx` / `StudentTable.tsx` | The student roster table (shared component also used by `MyBatch.tsx`), with search, section/source filters, CSV export. |
| `AdminEnrollments.tsx` | A CSV-paste UI for `Enrollment` exceptions (ADD/DROP), validating every line against the real `TimetableSlot` data before allowing save (won't let you enroll someone ADD-ing a course/section pair that doesn't actually exist in the timetable). |
| `AdminTimetableEditor.tsx` | Manual per-class correction UI over already-ingested `TimetableSlot` rows. |
| `AdminClassReps.tsx` | Lists every claimed `ClassRep` with a Revoke button (`revokeCr()`). |
| `AdminActivity.tsx` | Cross-batch activity log: loads all `ScheduleChange` rows with a `date`, folds them through `toActions()`, filters to the same "this week and next" window as the student feed, filterable by batch. |

## Shared UI components

- **`TimetableGrid.tsx`** — the one visual grid used by student, CR-search-preview, and admin editor screens alike. Its hard problem: the real institute sheets lay out classes so a 2-hour class and a 1-hour class can occupy the same time window in the same day, side by side — an HTML `<table>` can't express that with `colSpan` (spanning cells can't overlap arbitrary neighbors), so `layoutDay()` computes a lane-packed CSS grid per day instead: every class becomes a `{start, end}` span, spans are sorted by section-then-time, and each is placed in the first lane where its hour range is free. This is a from-scratch layout algorithm, not a library.
- **`courseColor.ts`** — deterministic per-course-code color via a string hash into a small curated palette (not random hue generation), so the same course always renders the same color across every screen and every session without persisting anything.
- **`StudentTable.tsx`** — the roster table shared verbatim between the student-facing `MyBatch.tsx` and the admin-facing `AdminStudents.tsx`, taking a `crByRollId` map so it can badge whoever holds CR without either caller needing separate logic.
- **`ActionLine.tsx`** — renders one folded `Action` (from `lib/changes.ts`) consistently across the student feed, CR's own change history, and the admin activity log.

## The `lib/` layer — where the real logic actually lives

Slate's frontend consistently keeps business logic out of components and in `src/lib/`, which is the main reason screens stay readable at 300–500 lines each despite doing real work:

- **`lib/grid.ts`** — the canonical weekly hour grid (`HOURS`, pulled from the real ingested spreadsheet's own time columns, lunch 13:00–14:30 deliberately excluded as a candidate slot), all date arithmetic done in UTC specifically so the browser's local timezone can't shift a date by a day (`asUtc`, `mondayOf`, `addDays`, `todayIst` all documented with this exact rationale in comments), and `buildGrid()` — the effective-timetable computation (regular classes − cancellations + extras) that both the student dashboard and the CR's slot-search preview call identically, so what a CR sees while proposing a change and what a student later sees are guaranteed to be the same function, not two independent re-implementations that could drift.
- **`lib/classReps.ts`** — thin, typed wrappers around the six `section-changes`-backed mutations (`claimCr`, `cancelOccurrence`, `addExtra`, `moveOccurrence`, `undoChange`, plus `revokeCr` which goes straight to the `ClassRep` model's own `delete`). All server logic lives in the Lambda; this file is purely a typed call-and-unwrap-errors layer.
- **`lib/rollLookup.ts`** — `resolveSectionFromEmail()`/`fetchBatchRoster()`, wrapping the `mySection`/`batchRoster` queries, with a comment explicitly noting the student-list data these queries read is admin-only, which is *why* the lookup has to happen server-side rather than the frontend scanning `StudentSection` itself.
- **`lib/changes.ts`** — `toActions()` folds the one-row-per-affected-section `ScheduleChange` model back into one logical "Action" per real-world change (a move is two kinds of row sharing a `groupId`; this collapses them into one card with a `from`/`to` pair), used identically by the student feed, the CR's own history, and the admin activity log.
- **`lib/listAll.ts`** — the pagination helper every screen's initial data load goes through; without it, any batch with more than 100 rows (the default Amplify list page size) would silently show incomplete data.
- **`lib/courseNames.ts`** — a small static lookup of course code → full name for tooltips, hand-maintained from the real course legend, not derived.

One deliberate piece of duplication, called out in comments rather than hidden: `NewRequest.tsx` re-implements small pieces of section-matching logic (`reach()`, `blocks()`) that also exist in the `section-changes` Lambda and in `shared/attendance.ts`, because the frontend needs the same "which sections does this reach" answer to pre-select checkboxes *before* the server round-trip — but every comment next to these duplicated functions says "same rule as the server" and the server is the one that's actually authorized to enforce it; the frontend copies are UX-only pre-selection, never trusted for security decisions.

## Talking to the Amplify-generated client

Every screen that touches data calls `generateClient<Schema>()` once at module scope (`const client = generateClient<Schema>()`), using the `Schema` type inferred directly from `amplify/data/resource.ts` — so a schema field rename shows up as a TypeScript error in every consuming component immediately, without any manual type maintenance.

One recurring, explicitly-commented workaround appears in `NewRequest.tsx`, `useMyProfile.ts`, and `AdminUpload.tsx`: Amplify's generated types for **custom** (Lambda-backed) queries/mutations sometimes collapse to a useless shape, so those call sites hand-cast `client.queries`/`client.mutations` to a small manually-written interface (e.g. `findSlots: (a: {...}) => Promise<{data: unknown; errors?: ...}>`) instead of trusting the generated type. Every one of these casts is commented as a known Amplify type-inference limitation, not silent `any`-typing — the runtime shape is still correctly typed by hand.

Responses from custom Lambda-backed operations return JSON as a possibly-double-encoded string (AppSync's `a.json()` return type plus the Lambda's own `JSON.stringify()`), so call sites uniformly do `while (typeof payload === 'string') payload = JSON.parse(payload)` before using the result — a small but consistent pattern repeated verbatim across `NewRequest.tsx`, `rollLookup.ts`, and `AdminUpload.tsx`.

## What's not here (planned-but-not-built, frontend side)

- No `TeacherDashboard.tsx` — despite `README.md`'s repo map listing one, no such file exists in `src/`; the faculty-facing UI was cut in the Day-3 pivot and the README wasn't fully updated.
- No client-side router — every navigation is tab state, so there are no deep links, no browser back/forward support within the app, and no shareable URLs to a specific screen. This is a reasonable hackathon-scope tradeoff for a two-tab-bar app, not an oversight to hide, but worth naming if asked about frontend architecture maturity.
- No automated frontend tests (no Jest/Vitest/Testing Library setup in `package.json`). Verification was manual, against the live deployed URL, per the checklist in `docs/TESTING.md`.
