# Demo video — 3 minutes, one thread

**Rules that shape this:** max 3 minutes; AWS must be *visible in use*, not just named; a feature that isn't in the video doesn't exist. Record at 1080p or better, browser zoomed so text is readable on a phone.

**Before recording**
- Sign in as `iit2024245` (Sec C CR) in one window, `iit2024059` (Sec A) in a second, `test-admin` in a third — switching accounts on camera wastes 20 seconds each time.
- Have a terminal ready with the CloudWatch command (shot 5) already typed.
- Clear old changes so "What changed" starts empty.

---

### 0:00–0:20 · The problem, in their words

**Screen:** a WhatsApp group thread (blur names), then a student staring at a printed timetable.

> "A class gets cancelled. The professor tells the CR, the CR posts in the group, and whoever muted that group walks to an empty room. And if you're taking an elective with three other sections, no printed timetable even shows your real week."

### 0:20–0:50 · A student's actual week

**Screen:** sign in → My Timetable as `iit2024059`.

> "This is a real fifth-semester student, signed in with their institute email. These are the courses they're actually registered in — core courses with their section, Entrepreneurial Finance with students from everywhere, and Software Engineering with the junior batch, because they're repeating it."

Point at **Up next** and the **amber now-line**.

> "It answers the question you actually open it for: what's next, where, and how long have I got."

**AWS on camera (1/3):** as you sign in, show the Cognito sign-in and say: *"Sign-up is restricted to @iiita.ac.in by a Cognito trigger — that's the boundary of the community."*

### 0:50–1:35 · The CR makes a change

**Screen:** switch to `iit2024245` (Sec C's CR) → click Thursday's IML → **Cancel on Thu 24 Sep**.

> "Each section has one class representative. The professor tells them; they record it here. It's stamped with their roll number, so a change is never anonymous."

Then **Make a change → Extra class → IML → Find free slots**.

> "For a makeup class, Slate doesn't search sections — it searches *people*: all 109 students registered in this course, whatever section or batch they're in, plus the professor. It's free for every one of them, it names why, and it suggests a room that's free too."

Then set a tight window so nothing fits:

> "And when nothing works, it tells you who's blocking it and with what — that's the part a WhatsApp poll can never do."

### 1:35–2:05 · It reaches exactly the right people

**Screen:** switch to the other student window, refresh.

> "Same course, different section — the change is already here, struck through, with the CR's roll number on it. And a student who isn't registered in that class sees nothing, because changes attach to the offering, not to a section."

**AWS on camera (2/3):** the admin window → **Upload Data** → show the real spreadsheet being read and the review screen.

> "Admins upload the institute's own sheets. They go to S3, a Lambda parses them, and nothing is written until the admin confirms what changes."

### 2:05–2:30 · Who's allowed to do that (the Cedar moment)

**Screen:** the terminal, live:

```bash
aws logs tail /aws/lambda/amplify-slate-kavyan2-san-sectionchangeslambdaB78D-5jYgBZhyLGrP \
  --since 10m --profile slate --region ap-south-1 | grep cedar
```

> "Every change runs through a Cedar policy in a Lambda. You can see the decisions in CloudWatch — allow for the CR, deny for anyone else. The rule is a file in the repo, not an if-statement buried in the UI."

**AWS on camera (3/3).** Show one `"cedar":"allow"` and one `"cedar":"deny"` line.

### 2:30–2:45 · Architecture and the URL

**Screen:** the README's architecture diagram, then the live URL in the address bar.

> "Amplify Hosting, Cognito, AppSync and DynamoDB with TTL, four Lambdas, S3 for the uploads, Cedar for authorization, CloudWatch for the audit. Month-to-date cost: zero — it all scales to zero between classes."

### 2:45–3:00 · What we learned

> "Two things. Real institutional data has a dozen notations for the same fact — one professor's name is truncated mid-word — and every notation we didn't handle silently lost a real course for a real student. And we changed who this is for, halfway: professors won't log in for this. The CR already does the work, and every section has one."

---

## Shot list checklist

- [ ] Cognito sign-in visible
- [ ] A student's week with an elective and a cross-batch course
- [ ] Up next + now-line
- [ ] CR cancels a class (roll number visible)
- [ ] Slot finder: ranked reasons, room, student count
- [ ] The no-slot explanation
- [ ] The change appearing for a *different* student
- [ ] Admin upload → S3 → Lambda parse → review
- [ ] CloudWatch Cedar allow **and** deny
- [ ] Architecture diagram + live URL
