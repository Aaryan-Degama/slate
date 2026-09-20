# Slate — demo video script

For **First Commit** (WeMakeDevs × AWS), Ship It track. https://www.wemakedevs.org/aws/first-commit

**Hard limit: 3:00.** Judges never see a live demo — this video *is* the submission. Every claim in it must be something the live app at https://main.dosqfo1xoqa7l.amplifyapp.com actually does today; nothing here is aspirational.

The five things being scored, and where each one is covered below:

| Judging criterion                | Covered at                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Idea & impact                    | 0:00–0:20                                                                            |
| Built on AWS (mandatory)         | 0:20–0:52, 1:50–2:12, 2:12–2:35                                                    |
| Execution (does it actually run) | 0:52–1:50                                                                            |
| Learning                         | 2:35–3:00                                                                            |
| Demo video itself                | all of it — one continuous thread, no cuts to slides except the architecture diagram |

One thread, one story: a real change to a real timetable, made by the person who actually makes it, seen instantly by the people it affects, enforced server-side. Don't cut to a menu tour — every second is either that story or an AWS callout.

**Three speakers**, each owning a stretch and one signed-in window, so nobody hands the mouse over mid-sentence:

| Who | Owns | Window |
| --- | --- | --- |
| **Jalendu** | 0:00–0:52 — the problem, and a student's real week | `iit2024059@iiita.ac.in` |
| **Degama** | 0:52–1:50 — the CR makes a change, and it lands | `iit2024245@iiita.ac.in` (CR of Sec C) |
| **Kavyan** | 1:50–3:00 — enforcement, ingestion, architecture, learning | `demo-admin@iiita.ac.in` + a terminal |

---

## Before you hit record

- **Signed-in accounts ready** (password `SlateDemo#2026` for all): `iit2024059` (Sec A student), `iit2024245` (Sec C student **and** its CR), `demo-admin` (ADMIN group). Sign in beforehand — logging in on camera costs 40 seconds.
- **No pending changes**: "What changed this week and next" should read "No changes" in both student windows, so the change Degama makes is visibly new.
- **Two browser windows side by side** for `iit2024059` and `iit2024245`, so "another student sees it too" is a window-switch, not a re-login.
- **A terminal** with this typed but not run, font bumped for legibility:
  ```bash
  aws logs tail /aws/lambda/amplify-slate-kavyan2-san-sectionchangeslambdaB78D-5jYgBZhyLGrP \
    --since 15m --profile slate --region ap-south-1 | grep cedar
  ```
- **Record at 1440p+** so course codes and the Cedar log line survive compression. Cursor highlighting on.
- **Do one full dry run.** First takes always run ~40 seconds long, and with three people the overrun compounds at each handoff.

Say the roll numbers and course codes out loud exactly as spelled — IML, IVP, EF, IIT2024059 — a judge will pause the video to check them against the repo.

---

## Shot-by-shot script

Voiceover is written to be read at a normal pace (~150 wpm) — don't rush it. Timings are targets; the whole segment must land inside its window.

### Jalendu · 0:00–0:20 — The problem (20s, 52 words)

**Visual:** Cold open on a title card — "IIIT Allahabad, Thursday. The IML class is cancelled." — held 2s, then a staged WhatsApp group thread, names blurred.

**Voiceover:**

> "At IIIT Allahabad a cancelled class reaches you on WhatsApp — if you see it. And if you take an elective with students from three other sections, no printed timetable even shows your real week. Both of those already have an answer sitting in the institute's own files. That's Slate."

### Jalendu · 0:20–0:52 — A real student's real week, on real infrastructure (32s, 78 words)

**Visual:** The live URL in the address bar, the Cognito sign-in screen with an `@iiita.ac.in` address visible, then My Timetable for `iit2024059`. Point at **Up next**, then the **amber now-line**. Open **My courses** and hold on **EF** and **SE**.

**Voiceover:**

> "This is the deployed app. Sign-in is Amazon Cognito, gated so only an IIITA email can create an account at all. Up next tells this student what's coming and where; the amber line is where we are in the day. And these are their real courses — core ones with their section, Entrepreneurial Finance as an elective, and Software Engineering with the *junior* batch, because they're repeating it. A section timetable can't show that. This is built from who's registered in what — eighteen hundred students and forty-eight hundred registrations, read from the institute's own sheets."

**AWS callout:** say "Amazon Cognito" while the sign-in is on screen.

**Handoff:** "That's a student. The person who actually changes any of this is the class rep — Degama."

### Degama · 0:52–1:10 — Who gets to change it (18s, 44 words)

**Visual:** Switch to your window. The CR line on My Timetable naming Sec C. Click **Thursday's IML class → Cancel on that date**. The class stays on the grid, struck through, tagged with your roll number.

**Voiceover:**

> "I'm a student too — and Section C's class rep, the person the professor actually tells. So I record it here. The class doesn't vanish; it stays struck through with my roll number on it, because 'cancelled' and 'never existed' are different things."

### Degama · 1:10–1:50 — The core moment: a makeup slot that fits real people (40s, 96 words)

**Visual:** **Make a change → Extra class → IVP**. Show the line saying the change reaches everyone registered in that class (Sec B2 and C). **Find free slots** → the ranked list with reasons and a free room. Then tighten the time window so nothing survives → the "No slot works" explanation naming the blocker.

**Voiceover:**

> "Now a makeup class. I pick IVP — Professor Vrijendra Singh teaches it to sections B2 and C, and Slate already knows that from the timetable it ingested. But it doesn't search *sections*: a Lambda checks every student registered in this course, whatever batch they're in, against the professor's own schedule, ranks what's left, and suggests a room that's free too — with the reason written out. And when nothing fits, it names who's blocking it and what they have then. That's interval maths over every affected timetable at once. A chatbot has none of this data."

**Handoff:** "Let's see what that did to everyone else's week — and who's allowed to do it. Kavyan."

### Kavyan · 1:50–2:12 — It's live for everyone, and it's enforced (22s, 56 words)

**Visual:** Switch to Jalendu's window, refresh: the change is on the grid labelled with the CR's roll number, and **"What changed this week and next"** shows it as new. Click **Mark as seen**. Then the terminal: run the CloudWatch command, hold on one `"cedar":"allow"` and one `"cedar":"deny"`.

**Voiceover:**

> "It's already on every affected student's timetable, with who made it, flagged new until they've seen it. And this isn't the interface being polite — every change is decided by a Cedar policy inside the Lambda, and every decision, allow or deny, lands in CloudWatch. A student who isn't the CR is refused on the server, not hidden in the UI."

### Kavyan · 2:12–2:35 — Ingestion and architecture (23s, 59 words)

**Visual:** Admin window → **Upload Data**, drop a real timetable sheet, show the review screen. Then the architecture diagram from `README.md`, highlighting each piece as named. End on the live URL.

**Voiceover:**

> "This all comes from the institute's own spreadsheets: they go to S3, a Lambda parses them — merged cells, electives, lab splits and all — and nothing is written until an admin confirms the diff. Cognito, AppSync and DynamoDB, four Lambdas, S3, Cedar, CloudWatch, served from Amplify Hosting. No EC2, no NAT gateway, nothing idling. Month-to-date cost: zero."

### Kavyan · 2:35–3:00 — What we learned (25s, 62 words)

**Visual:** Back on a student's week, then the end card.

**Voiceover:**

> "Two things. Real timetables write the same fact a dozen ways — one professor's name is truncated mid-word — and every notation we didn't handle silently lost a course for a real student. And we changed who this is for halfway through: professors won't log in for this. The class rep already does the work. We just gave it a server, and an audit trail."

**End card:** Slate mark, live URL, "Built for First Commit — WeMakeDevs × AWS."

---

## Word-count check

Counted from the voiceover blocks above (re-run `wc -w` if you edit them — don't trust stale numbers).

| Segment                | Speaker  | Target seconds | Words        | wpm           |
| ---------------------- | -------- | -------------- | ------------ | ------------- |
| Problem                | Jalendu  | 20             | 52           | 156           |
| Real week / Cognito    | Jalendu  | 32             | 78           | 146           |
| Who may change it      | Degama   | 18             | 44           | 147           |
| Core moment            | Degama   | 40             | 96           | 144           |
| Live + enforced        | Kavyan   | 22             | 56           | 153           |
| Ingestion + architecture | Kavyan | 23             | 59           | 154           |
| Learning               | Kavyan   | 25             | 62           | 149           |
| **Total**              |          | **180**        | **447**      | **149**       |

If a read-through runs long, cut in this order: the no-slot beat inside the core moment (−10s, Degama), then the upload shot (−12s, Kavyan — then say "parsed by a Lambda from S3" over the CloudWatch shot), then the second learning (−8s).

**Never cut:** the cross-batch week (it's the idea), the change appearing on a second student's screen (it's the proof), the Cedar deny (it's the AWS requirement).

## After recording

- Upload unlisted (or per submission instructions), confirm it's exactly ≤3:00.
- Re-watch once muted with captions on, to check on-screen text — course codes, roll numbers, the Cedar log line — is readable without audio.
- Update this file if the recorded cut deviates, so the repo and the video stay in sync for a judge cross-checking both.
- Keep a copy in the repo: `docs/VIDEO-SCRIPT.md`.
