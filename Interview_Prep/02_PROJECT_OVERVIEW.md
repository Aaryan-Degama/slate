# 02 — Project Overview

## The problem, in one sentence

At IIIT Allahabad, when a class needs to change — a professor cancels a lecture, adds a makeup class, or moves a session — the professor tells the class representative (CR), the CR tells the class over WhatsApp, and if the change touches more than one section (a shared elective, a course three sections take with three different professors), nobody can see all the relevant timetables at once, so finding one hour where nothing clashes becomes a day of polling people who might not even reply.

## Why this is a real problem, not a hackathon-invented one

The information needed to answer "when is everyone free?" already exists — it's sitting in separate, static timetable spreadsheets per section, ingested once a semester and otherwise never cross-referenced. Nobody has built the tool that reads all of them together. That's the whole gap: not a lack of data, a lack of one place that holds it all and can do interval arithmetic on it.

`CLAUDE.md` records the project's own history honestly: this is the *third* idea the team tried in the same 4-day window. A campus lost & found app was abandoned (two-sided marketplace problems consistently fail to get adopted — there's a documented dead attempt at IIITA itself). A broader "curriculum + timetable + free-slot" tool was too much surface area for a hackathon. Slate is the distilled version of that second idea: one feature, done properly, chosen because:

- It has no prior art the team found anywhere.
- It has the sharpest "why isn't this just an LLM" answer of anything they considered — a chatbot doesn't have every affected section's and every professor's timetable loaded at once; a Lambda doing interval intersection does.
- It needs no second user to already exist. The "community" it coordinates — sections, CRs, professors — are real, pre-existing groups, not something Slate has to bootstrap.

## What Slate actually is (as built, not as first planned)

Slate is a small, closed (IIITA-email-only) web app with three roles, only two of which are separate UIs:

- **Student** — sees their own week (this week and next only), knows who their CR is, sees a "What changed" feed, can view their whole batch's section roster.
- **Class Representative (CR)** — a student who has claimed their section (first to claim; admin can revoke). Everything a student sees, plus the ability to Cancel a class, add an Extra class, or Move a class — for the *course*, reaching every section that course's professor teaches, not just their own section.
- **Admin** — uploads the source timetable/student-list spreadsheets, corrects mistakes, manages CRs, and reviews an activity log across all batches.

There is no professor login. Professors' timetables are ingested data only, consumed by the slot-finding logic so a CR's proposed extra class doesn't clash with the professor's other classes anywhere in the institute — but professors never sign in and never confirm anything themselves. This is a deliberate mid-build pivot (documented in `docs/PLAN.md`): the product started faculty-driven ("a professor schedules, students see it") and moved to student-run because that's how changes actually happen at IIITA — the professor tells the CR, the CR tells everyone.

## Core concepts (the vocabulary the whole app is built on)

- **Batch** = program + branch + semester, e.g. "B.Tech IT Sem 5." A CR's powers never leave their batch.
- **Section** = A, B, C, with sub-groups like B1/B2 belonging to B. A student's section is derived from their roll number via admin-uploaded data (`StudentSection` rows, or `RollRange` fallback ranges) — never a self-selected dropdown that can be gamed into claiming CR of a section you're not in.
- **Regular class** — a weekly `TimetableSlot` row: read-only, ingested once per semester, only an admin corrects it.
- **Occurrence** — a regular class on one specific calendar date. "IML on Monday" is a regular class; "IML on Mon 22 Sep" is an occurrence.
- **Change** — always dated, one of three kinds: **Cancelled** (an occurrence called off), **Extra** (a one-off class on a date), or **Moved** (a linked cancel + extra, treated as one action). Every change records who made it (CR roll number and section) and when; undo doesn't delete the record, it marks it "undone by …" so the history stays honest.
- **Effective timetable for a date** = that weekday's regular classes, minus that date's cancellations, plus that date's extras. It's computed on every render (`src/lib/grid.ts`'s `buildGrid()`), never stored as its own table — there is no cached "today's schedule" row anywhere that could go stale.

## Who sees what, concretely

A student's week view shows cancelled occurrences struck through with who cancelled them, extra classes marked with who added them, and — if their batch has uploaded elective registrations — only the electives they're actually registered in (otherwise the whole elective basket shows, labelled "registration not uploaded" so nobody mistakes it for confirmed data). Their My Batch screen shows every section of their *own* batch — never another batch, enforced server-side by a dedicated `batchRoster` query, not a client-side filter that could be bypassed.

A CR gets one extra entry point, "Make a change," with three actions. The interesting one is Extra class: pick a course, and the sections its professor teaches (not necessarily the whole course — IML in IT Sem 5 has three separate professors for its three sections) are pre-selected. The system then searches dated slots free for every affected section, the batch's electives, and the professor, returning ranked results with a reason ("free for all 3 sections · within 9–5:30 · avoids the lunch hours"), a suggested free room, and — if nothing works — an explanation of exactly which section or which professor is the bottleneck, and an example of the closest near-miss.

An admin uploads the institute's own inconsistent spreadsheets, reviews exactly what would change before anything writes, manages who holds CR for each section, and has one activity log across every batch, for this week and next.

## Non-goals — deliberately, in writing, from day one

`CLAUDE.md` lists what was cut before building started, and it held: no voting/approval flow between CRs (one CR decides for the course; another section's CR can independently undo for their own section only), no chat/messaging, no professor logins, no recurring changes (every change is tied to one date, there's no "cancel this class every week"), no crowdsourced edits to the regular timetable (admin-only), no user-created groups, no native app, no multi-institution support (IIITA is hardcoded throughout — email domain, weekday names, the hour grid pulled from a real AAA sheet). This discipline is why a 4-day team shipped something that actually runs end to end instead of five half-built screens.

## The interview-ready elevator pitch

"Slate answers one question that currently takes a day of WhatsApp polling: when is the next hour that every section taking this course, and the professor teaching it, are all free? It does that with plain interval intersection over real, ingested timetable data — no LLM, because an LLM doesn't have every section's and every professor's schedule loaded at once, and this problem doesn't need pattern matching, it needs correct arithmetic over structured time ranges. Authorization is a real Cedar policy evaluated server-side in a Lambda, not an `if` statement, because 'which CR can change which course's classes' is exactly the kind of rule you want to be able to audit and test independent of the handler code. And the one place we were honest about limits: institutional timetable formatting is genuinely inconsistent across departments, so the automated `.xlsx` reader is validated against each course's own credit structure and flags what it can't confidently parse for a human — nothing is guessed."
