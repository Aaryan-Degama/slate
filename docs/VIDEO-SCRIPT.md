# Demo video — 3:00 hard limit, three voices

Live narration while you click. Each person owns a stretch of the story and one screen, so nobody hands the mouse over mid-sentence. Say the lines in your own words; keep the order and the handoffs.

**Shaped by the rules:** 3 minutes maximum, AWS must be visible *in use*, and a feature not in the video doesn't exist. Time goes to the two things nobody else can show — **a real student's cross-batch week** and **a live Cedar decision in CloudWatch**.

| Who | Owns | Time |
|---|---|---|
| **Jalendu** | The problem and a student's week | 0:00–0:55 |
| **Degama** | The CR making a change, and it landing | 0:55–1:50 |
| **Kavyan** | Authorization, ingestion, architecture, learnings | 1:50–3:00 |

---

## Before recording

- **Three browser windows, already signed in** (password `SlateDemo#2026`):
  1. `iit2024059@iiita.ac.in` — student, Sec A → **Jalendu**
  2. `iit2024245@iiita.ac.in` — student **and CR of Sec C** → **Degama**
  3. `demo-admin@iiita.ac.in` — admin → **Kavyan**
- **Terminal** with this typed but not run → **Kavyan**:
  ```bash
  aws logs tail /aws/lambda/amplify-slate-kavyan2-san-sectionchangeslambdaB78D-5jYgBZhyLGrP \
    --since 15m --profile slate --region ap-south-1 | grep cedar
  ```
- **"What changed" empty** in both student windows.
- Zoom ~110%, notifications off, one screen recording with all three windows arranged, or a clean cut per speaker.
- Do one dry run end to end. The first take is always 40 seconds long.

---

## Jalendu — 0:00–0:55 · The problem, and a real week

**0:00–0:15 · Screen:** the sign-in page, or a WhatsApp group with names blurred.

> "At our college a cancelled class reaches you on WhatsApp — if you see it. And if you take an elective with three other sections, no printed timetable shows your real week. Slate fixes both."

**0:15–0:55 · Screen:** your window, My Timetable.

> "This is a real fifth-semester student on real institute data — 1,800 students and 4,800 registrations, loaded from the department's own sheets."

*Point at Up next, then the amber line.*

> "Up next tells them what's coming, where, and how long they've got. The amber line is where we are in the day right now."

*Open My courses.*

> "And these are their actual courses: core ones with their section, Entrepreneurial Finance as an elective, and Software Engineering with the **junior batch**, because they're repeating it. A section-based timetable can't show that — ours is built from who's registered in what."

**AWS on camera (1/3)** — say it while the page is up:

> "Sign-in is Cognito, restricted to our institute's domain by a Lambda trigger."

**Handoff:** "So that's a student. The person who actually changes any of this is the class representative — Degama."

## Degama — 0:55–1:50 · The CR changes something, and it lands

**Screen:** your window, `iit2024245`.

*Click Thursday's IML → Cancel on that date.*

> "Every section has a CR. The professor tells them, they record it here — and it's stamped with their roll number, so no change is anonymous."

*Make a change → Extra class → IML → Find free slots.*

> "For a makeup class, Slate doesn't check sections — it checks **people**: all 109 students registered in this course, whatever section or batch they're in, plus the professor. Every slot it offers is free for all of them, with the reason written out and a room that's free too."

*Narrow the window so nothing fits, search again.*

> "And when nothing fits, it names who's blocking it and with what. That's the part a WhatsApp poll can never do."

*Switch to Jalendu's window and refresh — or have him refresh on camera.*

> "Different section, same course: the change is already here, struck through, with my roll number on it. A student who isn't registered in that class sees nothing."

**Handoff:** "Which raises the obvious question — who's allowed to do that? Kavyan."

## Kavyan — 1:50–3:00 · Rules, ingestion, architecture, learnings

**1:50–2:15 · Screen:** the terminal. Run the command.

> "Every change goes through a Cedar policy running in a Lambda. These are the live decisions — allow for the CR, deny for anyone else. The rule is a policy file in the repo, not an if-statement buried in the UI."

**AWS on camera (2/3).** Hold on one `"cedar":"allow"` and one `"cedar":"deny"` for two full seconds.

**2:15–2:35 · Screen:** admin → Upload Data → drop a timetable sheet → the review screen.

> "Admins upload the institute's own spreadsheets. They land in S3, a Lambda parses them — merged cells, electives, sub-sections and all — and nothing is written until the admin confirms the diff."

**AWS on camera (3/3).**

**2:35–2:50 · Screen:** the architecture diagram in the README.

> "Amplify Hosting, Cognito, AppSync and DynamoDB with TTL on the changes, four Lambdas, S3 for uploads, Cedar for authorization, CloudWatch for the audit trail. Month-to-date cost: zero. It scales to zero between classes."

**2:50–3:00 · Screen:** back to a student's week, then the URL.

> "Two things we learned. Real timetables write the same fact a dozen ways — one professor's name is even cut off mid-word — and every notation we didn't handle silently lost a course for a real student. And we changed who this is for halfway through: professors won't log in for this. The CR already does, and every section already has one."

---

## Checklist

- [ ] Cognito sign-in mentioned while visible (Jalendu)
- [ ] Up next + amber now-line (Jalendu)
- [ ] My courses: an elective **and** a junior-batch course (Jalendu)
- [ ] CR cancels a class, roll number visible (Degama)
- [ ] Slot finder: "free for all 109 registered students", reasons, room (Degama)
- [ ] No-slot case naming the blocker (Degama)
- [ ] The change on a **second** student's screen (Degama → Jalendu's window)
- [ ] CloudWatch: one allow, one deny (Kavyan)
- [ ] Admin upload → S3 → Lambda parse → review (Kavyan)
- [ ] Architecture diagram + live URL (Kavyan)

## If it runs long

Cut in this order: the no-slot case (−10s, Degama), the admin upload (−15s, Kavyan — then say "the sheets are parsed by a Lambda from S3" over the CloudWatch shot), the second learning (−8s, Kavyan).

**Never cut:** the cross-batch week, the change landing on another student's screen, the Cedar deny.

## Handoff discipline

- Each speaker ends with the one-line handoff above. It buys the next person two seconds to take over the screen.
- Don't re-introduce the product; each segment continues the same sentence someone else started.
- If a page is slow, keep talking about what's about to appear — never narrate the spinner.
