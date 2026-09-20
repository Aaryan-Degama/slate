# Submission — Slate

**First Commit** (WeMakeDevs × AWS) · Track: **Ship It** · Sept 17–20, 2026

---

## Links

| | |
|---|---|
| **Live app** | https://main.dosqfo1xoqa7l.amplifyapp.com |
| **Repo** | https://github.com/kavyan256/slate |
| **Demo video** | _paste the link here — must play without sign-in_ |
| **Writeup** | [`WRITEUP.md`](WRITEUP.md) in this repo |

## One line

Slate shows a student their *real* week at IIIT Allahabad — the courses they're actually registered in, including electives and courses taken with another batch — and lets their class representative cancel, move or add a class so everyone in it finds out.

## Sign in without registering

Sign-up is restricted to `@iiita.ac.in`, so these accounts are ready to use. Password for all four: **`SlateDemo#2026`**

| Account | What to look at |
|---|---|
| `iit2024059@iiita.ac.in` | A student's week: **Up next**, the live now-line, and under **My courses** an elective plus a third-semester course taken with the junior batch — a section-based timetable can't show this |
| `iit2024245@iiita.ac.in` | The same, plus **CR of Sec C**: click a class to cancel or re-time it, or use **Make a change** to find a makeup slot free for all 109 students registered in the course and the professor |
| `iib2024001@iiita.ac.in` | A B.Tech BI student in that same section, with a different elective — two classmates, two different weeks |
| `demo-admin@iiita.ac.in` | The admin side: upload the institute's spreadsheets, students, class reps, and the activity log of every change |

Changes made in one account appear in the others, which is the point of the product.

## What to try in two minutes

1. Sign in as `iit2024059` — note the elective (**EF**) and the junior-batch course (**SE**) on the week.
2. Sign in as `iit2024245` in another window, click a class, and **cancel it on a date**.
3. Back on the first account, refresh: the change is there, struck through, with the CR's roll number.
4. As the CR, open **Make a change → Extra class → IML → Find free slots**: every slot is free for all registered students and the professor, with reasons and a room. Narrow the window and it names who blocks it.
5. As `demo-admin`, open **Activity** to see every change, and **Students** for the 1,801 students loaded from real lists.

## Built on AWS

Amplify Hosting · Cognito (institute-domain gate, ADMIN group) · AppSync + DynamoDB (12 tables, GSIs, TTL on changes) · S3 (uploaded spreadsheets) · Lambda ×4 (`parse-timetable`, `import-data`, `find-slots`, `section-changes`) · **Cedar** policy engine inside the change Lambda · CloudWatch for every authorization decision.

**Month-to-date cost: $0.00** — everything scales to zero between classes.

Architecture diagram and the reasoning: [`README.md`](README.md) and [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).

## Real data, not fixtures

1,801 students across 8 batches · 104 offerings · 246 class meetings · 4,821 registrations — read from the department's own timetable workbooks, the per-year student lists and the mid-semester examinee list.

## Credits

[`CREDITS.md`](CREDITS.md) lists every library, starter template and AI coding tool used.
