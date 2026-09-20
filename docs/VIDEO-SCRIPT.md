# Demo video — 3:00 hard limit

Live narration while you click. Lines are written to be *said*, not read out — keep your own words, keep the order. Pacing assumes you pause where marked; the timings have ~10 seconds of slack for pages loading.

**Rules this is shaped around:** 3 minutes maximum, AWS must be visible *in use*, and a feature not in the video doesn't exist. So: the most time goes to the two things nobody else can show — **a real student's cross-batch week** and **a live Cedar decision in CloudWatch**.

---

## Before you hit record

- **Three browser windows, already signed in**, so no login waits:
  1. `iit2024245@iiita.ac.in` — Sec C student **and CR**
  2. `iit2024059@iiita.ac.in` — Sec A student (the one with EF and a junior-batch SE)
  3. `demo-admin@iiita.ac.in` — admin
  Password: `SlateDemo#2026`
- **A terminal** with this already typed, not yet run:
  ```bash
  aws logs tail /aws/lambda/amplify-slate-kavyan2-san-sectionchangeslambdaB78D-5jYgBZhyLGrP \
    --since 15m --profile slate --region ap-south-1 | grep cedar
  ```
- **"What changed" empty** in both student windows — do a clean run first, then undo it.
- Browser zoom ~110%, no bookmarks bar, notifications off.

---

## 0:00–0:15 · What's broken (keep it short)

**Screen:** the app's sign-in, or a WhatsApp group with names blurred.

> "At my college, a cancelled class reaches you on WhatsApp — if you see it. And if you take an elective with three other sections, no printed timetable even shows your real week. Slate fixes both."

*Don't dwell. The demo is the argument.*

## 0:15–0:55 · A real student's real week

**Screen:** window 2 — `iit2024059`, My Timetable.

> "This is a real fifth-semester IT student, on real institute data — 1,800 students, 4,800 registrations loaded from the department's own sheets."

Point at **Up next**, then the **amber line**:

> "Up next tells them what's coming, where, and how long they've got. The amber line is where we are in the day right now."

Open **My courses**:

> "And these are their actual courses — core courses with their section, Entrepreneurial Finance, which is an elective, and Software Engineering with the *junior* batch, because they're repeating it. A section-based timetable can't show that. Ours is built from who's registered in what."

**AWS on camera (1/3)** — say while the page is up:

> "Sign-in is Cognito, restricted to our institute domain by a Lambda trigger."

## 0:55–1:45 · The CR changes something, and it lands

**Screen:** window 1 — `iit2024245`, click Thursday's IML → **Cancel on Thu**.

> "Every section has a class representative. The professor tells them, they record it here — and it's stamped with their roll number, so nothing is anonymous."

Now **Make a change → Extra class → pick IML → Find free slots**:

> "For a makeup class, Slate doesn't check sections. It checks *people*: all 109 students registered in this course, whichever section or batch they're from, plus the professor. Every slot it offers is free for all of them, with the reason written out and a room that's free too."

Tighten the window so nothing fits, search again:

> "And when nothing fits, it says who's blocking it and with what. A WhatsApp poll can't do that."

**Screen:** switch to window 2, refresh.

> "Different section, same course — the change is already here, struck through, with the CR's roll number on it. Students not registered in that class see nothing."

## 1:45–2:20 · Who's allowed to do that

**Screen:** the terminal. Run the command.

> "Every change goes through a Cedar policy running in a Lambda. These are the live decisions: allow for the CR, deny for anyone else. The rule is a policy file in the repo, not an if-statement in the UI."

**AWS on camera (2/3).** Hold on one `"cedar":"allow"` and one `"cedar":"deny"` line for two full seconds.

**Screen:** window 3 — admin → **Upload Data**, drop a timetable sheet, show the review screen.

> "Admins upload the institute's own spreadsheets. They go to S3, a Lambda parses them — merged cells, electives, sub-sections and all — and nothing is written until the admin confirms the diff."

**AWS on camera (3/3).**

## 2:20–2:40 · How it's built

**Screen:** the README's architecture diagram.

> "Amplify Hosting, Cognito, AppSync and DynamoDB with TTL on the changes, four Lambdas, S3 for uploads, Cedar for authorization, CloudWatch for the audit trail. Month-to-date cost: zero. It scales to zero between classes."

## 2:40–3:00 · The honest bit

**Screen:** back on a student's week.

> "Two things we learned. Real timetables write the same fact a dozen ways — one professor's name is even cut off mid-word — and every notation we didn't handle silently lost a course for a real student. And we changed who this is for halfway through: professors won't log in for this. The CR already does the work, and every section already has one."

End on the live URL.

---

## Shot checklist

- [ ] Cognito sign-in mentioned while visible
- [ ] Up next + amber now-line
- [ ] My courses showing an elective **and** a junior-batch course
- [ ] CR cancels a class, roll number visible on the grid
- [ ] Slot finder: "free for all 109 registered students", reasons, room
- [ ] No-slot case naming the blocker
- [ ] The change on a *second* student's screen
- [ ] CloudWatch: one allow, one deny
- [ ] Admin upload → S3 → Lambda parse → review
- [ ] Architecture diagram, live URL

## If you're running long

Cut in this order: the no-slot case (0:10), the admin upload (0:15, but then say "the sheets are parsed by a Lambda from S3" over the CloudWatch shot), the second learning (0:08). Never cut: the cross-batch week, the change landing on another student's screen, the Cedar deny.
