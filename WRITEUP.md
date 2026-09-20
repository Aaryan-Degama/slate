# Slate — submission writeup

**Live:** https://main.dosqfo1xoqa7l.amplifyapp.com · **Repo:** https://github.com/kavyan256/slate · **Track:** Ship It

---

## The problem

At IIIT Allahabad a timetable change travels by WhatsApp. A professor tells the class representative, the CR forwards it to a group, and whoever muted that group walks to an empty room. When a makeup class has to suit several sections *and* the professor, finding an hour takes a day of polls — even though every timetable involved already exists on paper.

The deeper problem is that **"the timetable" isn't one thing**. A fifth-semester IT student takes core courses with their section, an elective with students drawn from three other sections, and sometimes a backlog course with the junior batch. No printed grid shows that student's actual week. We only understood this properly on day four, when we got the institute's own registration list and found students whose week matched no section at all.

## What we built

A student signs in with their institute email and sees **their** week: the courses they are registered in, including electives, minors and anything taken with another batch. A live marker shows where they are in the day; **Up next** names the next class, the room and how long they have.

Each section has one **class representative**, claimed in the app. A CR can cancel a class on a date, add an extra one, move it, or shorten it — and every change carries their roll number, so a change is never anonymous. Students see it annotated on the grid (struck through, not deleted) and in a "what changed" list.

When a CR needs a slot for a makeup class, Slate searches **the people, not the sections**: everyone registered in that course plus the professor, across whatever batches they belong to. Results are dated, ranked with the reason written out ("free for all 109 registered students · Dr. Shiv Ram Dubey is free · within 9–5:30 · avoids the lunch hours") and carry a free room. When nothing fits, it names who blocks it and with what.

Admins upload the institute's spreadsheets as they are, review exactly what would change, and apply it.

Everything runs on real data: **1,801 students** across 8 batches, **104 offerings**, **246 class meetings**, **4,821 registrations**, read from the department's own timetable workbooks, the per-year student lists and the mid-semester examinee list.

## Where AWS fits

| Service | What it does here |
|---|---|
| **Amplify Hosting** | Serves the app at a public URL; deploys are a built artifact, so no build minutes are burned |
| **Cognito** | A preSignUp trigger restricts sign-up to `@iiita.ac.in`, which is the community boundary. An `ADMIN` group grants the upload screens. The app talks to AppSync with access tokens, so the backend resolves a user's identity from the user pool rather than trusting anything the client sends |
| **AppSync + DynamoDB** | The schema generates the API. Twelve tables, secondary indexes for the hot reads, and **TTL** on timetable changes so anything older than its week deletes itself at no cost |
| **S3** | Holds the uploaded spreadsheets; the parser reads them from there, so a 16,000-row workbook never passes through a browser |
| **Lambda** | Four functions: `parse-timetable` (reads real `.xlsx`), `import-data` (validates, diffs, writes), `find-slots` (the interval intersection), `section-changes` (every write that changes a timetable) |
| **Cedar** | `policy.cedar` inside `section-changes` decides who may change what — claim a section only if it's yours and vacant; cancel or move only a class you attend as its CR. Every decision is logged |
| **CloudWatch** | Shows the Cedar allow/deny lines and each slot search: `{"cedar":"deny","action":"Cancel","principal":{"role":"STUDENT"}}` |

**Cost: $0.00 month-to-date.** No NAT gateway, no EC2, no OpenSearch; everything scales to zero between classes. Even institute-wide, this stays in single-digit dollars.

## What we learned

**Real institutional data has a dozen notations for the same fact.** The timetable sheets write a class as `IML (L) - Sec A (CC3-5404)`, but electives as `MDM-3 EF (CC3-5107)`, HSS courses as `IF Sec(A) (CC3- 5106)`, some rooms without brackets, and one professor's name truncated mid-word ("Dr. Nikhiland" for Dr. Nikhilanand Arya). Every notation we didn't handle silently lost a real course for a real student — a student registered in Entrepreneurial Finance simply saw a gap. Reading one sheet well taught us less than reading four badly.

**Identity is where the security actually lives.** Our first version trusted the section the browser sent. Then we found that Cognito access tokens carry no email claim, so the server couldn't identify anyone at all and every CR action failed for real users while passing our tests — because our tests supplied the email the browser never sent. The fix (look the user up in the user pool, derive their section from the admin-uploaded roll list) is also what makes Cedar's rules meaningful: a policy is only as good as the facts fed to it.

**Model the thing, not the screen.** We started with "a student attends their section's classes", then bolted on exceptions for drop-year students and electives. It kept almost working. Switching to *offerings and registrations* — one course as actually taught, and who signed up for it — deleted more code than it added and made electives, minors, lab splits and backlog courses ordinary cases.

**We also changed who the product is for, mid-build.** It began faculty-first: a professor schedules, students are notified. Two days in we accepted that professors won't log in for this, and that the person who actually does the work is the CR. The CR model needs no adoption campaign: every section already has one.

## Honest limitations

- **Ingestion is spreadsheet-driven, not Textract.** We planned Textract + Bedrock over PDFs; the institute's timetables arrived as `.xlsx`, so reading them directly is more accurate and cheaper. The Bedrock experiment (`slate/scripts/bedrock-normalize-timetable.py`) is kept in the repo rather than quietly deleted.
- **About 2,100 registration rows match no class** — institute-wide courses like Environmental Studies that appear in no departmental sheet. They're reported to the admin, never guessed at.
- **CR is first-come**, with an admin revoke, because an approval queue was more process than a four-day build could justify.
- **Changes cover this week and next only.** That's the window a timetable change lives in, and it keeps the data small enough to stay free.
