# Slate — team split (3 people)

Reference: see `CLAUDE.md` for the full frozen spec, architecture, data model and build order. This file only covers who does what and how to use AI on each piece.

Split along architecture boundaries so nobody edits the same files. Sync points are tied to the build order in `CLAUDE.md` §7.

---

## Kavyan — Critical path: AWS infra, ingestion, the algorithm

This is the part that has to work for the demo to have substance, and the part judges will actually ask about — own it end to end so you can speak to it fluently in the video's "what we learned" segment.

**Owns:**

- Cognito setup (IIITA domain gate, `role` attribute), Cedar policy for Confirm & Notify
- Amplify Gen 2 schema (`amplify/data/resource.ts`) — the four models in `CLAUDE.md` §4
- Textract + Bedrock ingestion pipeline on real AAA PDFs
- The slot-finding Lambda — interval intersection, constraints, room suggestion, blocking-section explanation (`CLAUDE.md` §5)
- SES wiring for Confirm & Notify

**AI usage — be selective, not blanket.** Let Claude Code scaffold the Amplify schema syntax and boilerplate IAM/Lambda wiring — that's pure mechanics. But **write the interval-intersection and blocking-section logic yourself, with AI as a reviewer, not an author.** Ask it to check your logic for edge cases rather than generate it whole. This is the one piece you must be able to explain unscripted on camera and to a judge. If AI writes it end to end and you can't explain why it works, the "what we learned" section falls apart on stage.

---

## Jalendu — Frontend: New Request + Proposed Slots

**Owns:**

- `New Request` screen — section picker, constraint inputs, submit
- `Proposed Slots` screen — ranked list with reasoning shown, room suggestion, and the no-slot-found blocking explanation UI
- Works against the Amplify-generated typed client once Kavyan's schema is deployed; can build against mock data first so this isn't blocked

**AI usage:** this is exactly the kind of screen-scaffolding work Claude Code is efficient at — give it the data model from `CLAUDE.md` §4, describe the two screens, let it build the component structure and forms. Do understand the shape of the data being rendered (so demo-day questions about "how does a proposed slot get its reason string" have a real answer), but the React/form plumbing itself is fine to fully delegate.

---

## Degama — Frontend: Confirm & Notify, deployment, data fallback, demo ops

**Owns:**

- `Confirm & Notify` screen — pick the winning slot, role-gated button (only shows for `role: FACULTY`), triggers the SES flow
- Amplify Hosting deployment and environment config — the person who can answer "is the live URL actually up" at any moment
- **Hand-structured fallback data** (`CLAUDE.md` §6/§7) — if the Textract gate test comes back weak on some programs, manually structure real timetable data from the actual PDFs so the demo never runs on fabricated data
- Video script and writeup skeleton, started day 2 onward so it's not a scramble on day 4

**AI usage:** same as Jalendu for the screen itself. For the data fallback work, AI is useful for turning messy PDF text into structured JSON faster than typing it by hand — paste the real curriculum/timetable text in, have it output the schema shape, then **verify every row against the source PDF**, because this becomes real demo data and an error here shows up on camera.

---

## Sync points

- **End of Day 1** — Kavyan has deployed Cognito + the schema skeleton + run the Textract gate test. Share the deployed schema/types so Jalendu and Degama can build against real types starting Day 2, not mocks.
- **End of Day 2** — Lambda has real logic, testable in isolation with real timetable data. New Request/Proposed Slots screens wired to it. Fallback data ready for any program that failed the gate test.
- **End of Day 3** — all three screens wired end to end, SES actually sending, Cedar gate actually blocking non-faculty. Full flow walked through once, together, on the live URL.
- **Day 4** — polish, record, write up, submit by midday.

---

## General AI discipline, all three people

- **Separate Claude Code sessions per person**, working in different parts of the tree (`amplify/` vs `src/screens/NewRequest` vs `src/screens/ConfirmNotify`) — avoids conflicting generated edits.
- **Small, frequent commits and pulls at the sync points above** — don't diverge for a full day before merging.
- **Keep a running note of what AI generated vs. hand-written**, per person, as you go — `CREDITS.md` needs this and reconstructing it on day 4 is worse than logging it now.
- **Never let AI-generated code substitute for understanding on the parts that get demoed or discussed** — screens can be fully AI-scaffolded since they're mechanical; the algorithm and the AWS architecture choices cannot, since those are exactly what "idea/impact," "learning," and judge Q&A will probe.i
