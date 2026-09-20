# Slate data model (registration-driven)

## Why change what we have

Today a student attends "their section's classes", with per-student exceptions bolted on. That was right when the only data we had was a timetable plus a section list. It breaks on everything the real institute does: electives, minors, open electives, drop-year students, lab splits, and courses shared across programmes.

The institute's own data says it plainly. The mid-sem examinee list (`MID SEM EXAMINEE LIST OCT 2026.xlsx`, 16,483 rows) has, for **every** B.Tech student:

```
PROG-SEM              ENROLL       STUDENTNAME    COURSENAME              FACULTYNAME
B.Tech (ECE) Sem-1    IEC2026001   ASMITA MITRA   Engineering Physics     PROF. AKHILESH TIWARI
```

That is a registration list: who takes what, from whom. Combined with the timetable (when and where each professor teaches each course, to which sections), it answers "what is this student's week?" exactly — no defaults, no exceptions.

**The shift:** a student attends the *offerings they are registered in*. A section is then just an attribute of a student (who their CR is, and which half of a lab split they're in), not the thing that decides their timetable.

---

## Entities

### Course
What a course *is*, independent of who teaches it or when.

```
code        "IML", "MDM-5 FA", "Bio-MEMs"   (as printed in the timetable legend)
name        "Introduction to Machine Learning"
kind        CORE | ELECTIVE | MINOR | OPEN_ELECTIVE | BASKET
ltps        [3,0,2,0]                        (from the legend, used to sanity-check hours)
```
*Sources:* the legend block of each timetable sheet (code, name, L-T-P-S, category). The 7th-sem sheet labels kinds directly: `MDM-n` is a minor degree module, `OPEN ELECTIVE …`, `Basket n:` lists basket electives.

### Offering
One course as actually taught this term, by one professor, to one audience. **This is the unit students register for and the unit a timetable cell belongs to.**

```
offeringId  hash of (term, courseCode, faculty, program, branch, semester)
term        "2026-ODD"
courseCode  "IML"
faculty     "Dr. Shiv Ram Dubey"
program/branch/semester   BTech / IT / 5        (the batch it is offered to)
sections    ["C"]  |  ["B2","C"]  |  ["*"]      (who it is timetabled for)
```
IML in IT Sem 5 is **three** offerings (Naveen Saini → A, Krishna P. Singh → B, Shiv Ram Dubey → C). An elective is one offering with `sections: ["*"]`, attended only by those registered.

### ClassMeeting
A weekly slot of an offering: what the timetable grid actually holds.

```
meetingId, offeringId
day, startTime, endTime
room, sessionType (L|T|P)
group       null | "B1" | "B2"     (a lab split: only that half attends)
```
*Sources:* the timetable sheets, as now (`parse-timetable`), but each cell resolves to an **offering** via its course code + the legend's professor for that section, rather than being stored per section.

### Student
```
rollId      "IIT2024245"   (prefix + admission year + number; the identity everywhere)
name, program, branch, semester
section     "C"            (for the CR, and for lab splits)
subSection  "B1" | null
```
*Sources:* the per-year `BTech_<year>_Names_RollNo.xlsx` files, which already carry ENROLMENT NO, STUDENT NAME, SECTION, SUBSECTION.

### Registration
```
rollId, offeringId, term
source      REGISTRY | ADMIN     (imported, or an admin correction)
```
*Sources:* the mid-sem examinee list. `COURSENAME + FACULTYNAME` → offering; `ENROLL` → student. **This replaces `Enrollment` (the ADD/DROP exceptions table) entirely.**

### ClassRep, ScheduleChange
Unchanged in spirit, but anchored to offerings:

```
ClassRep        section-level, as now (one per section of a batch)
ScheduleChange  groupId, kind (CANCELLED|EXTRA|MOVED_FROM|MOVED_TO), date,
                offeringId, meetingId (for a cancel/move), start/end, room,
                changedBy, changedBySection, undoneBy/At, expiresAt (TTL)
```
A change is made to an **offering**, so it reaches exactly the students registered in it — a cancelled Sec C IML no longer needs section arithmetic, and a shared class reaches both sections because both are registered in that one offering.

---

## What this makes easy

| Question | How it is answered |
|---|---|
| A student's week | their registrations → offerings → meetings (drop meetings whose `group` isn't theirs), plus this week's changes for those offerings |
| A drop-year student | just a registration in another batch's offering; nothing special |
| Electives and minors | an offering with `sections: ["*"]`; only registered students see it |
| Lab splits (B1/B2) | `group` on the meeting; the student's `subSection` decides |
| Who must be free for a makeup class | the offering's registered students — the exact set, not a section approximation |
| "Which sections does this affect?" | derived from the registered students, for display only |
| Room conflicts | meetings + dated changes, as now |

The slot finder gets simpler *and* more correct: gather the offering's students, union their other meetings for the candidate dates, intersect. No section/sub-section special cases, no "irregular attendee" concept — everyone is just a student with a set of meetings.

---

## Access patterns (DynamoDB)

All reads today are table scans, which is fine at 3,000 students but wasteful. With this model the hot paths have natural keys:

| Query | Key |
|---|---|
| my registrations | PK `STUDENT#<rollId>`, SK `REG#<term>#<offeringId>` |
| an offering's students | GSI: PK `OFFERING#<offeringId>`, SK `STUDENT#<rollId>` |
| an offering's meetings | PK `OFFERING#<offeringId>`, SK `MEETING#<day>#<start>` |
| changes for my offerings | GSI: PK `OFFERING#<offeringId>`, SK `DATE#<date>` |
| a batch's students | GSI: PK `BATCH#<program>#<branch>#<sem>`, SK `SECTION#<section>#<rollId>` |

Amplify Gen 2 gives secondary indexes with `.secondaryIndexes()`, so this is schema work, not hand-written infrastructure.

---

## Ingestion, in order

1. **Courses + offerings + meetings** — from the timetable sheets (extend the existing reader to emit offerings keyed by course + professor, and to read the legend's category so `kind` is real).
2. **Students** — the per-year name/roll/section files (already working).
3. **Registrations** — the mid-sem examinee list. Match `COURSENAME` → course by name, and `FACULTYNAME` → offering by professor; `PROG-SEM` confirms the batch. Anything unmatched is listed for the admin, never guessed.

Nothing else is needed: the elective preference file (`Elective_MDM_IKS.xlsx`) is superseded by the registration list, which is the outcome rather than the preferences.

**Worth collecting later:** the academic calendar (term start/end, holidays), so a cancelled class on a holiday can't be proposed, and room capacities if we ever want to check a room actually fits the class.

---

## Migration

The current tables are disposable: the timetable can be re-ingested, students are re-importable in minutes, and there are no real changes or CRs in the database.

1. Add `Course`, `Offering`, `ClassMeeting`, `Registration`; keep `Student` (rename of `StudentSection`), `ClassRep`, `ScheduleChange` (now offering-anchored).
2. Rewrite the timetable import to emit offerings + meetings.
3. Add the registration import.
4. Point the student week, the "what changed" list, the CR actions and the finder at offerings.
5. Delete `Enrollment`, `RollRange` and the section-default logic in `shared/attendance.ts`.

Steps 1–3 are a day's work; step 4 is mostly deleting special cases.
