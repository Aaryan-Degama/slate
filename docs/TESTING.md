# Testing checklist — B.Tech Semester 5

Run against the live app: <https://main.dosqfo1xoqa7l.amplifyapp.com>

Tick each box. Where a check fails, note what you saw — the expected values below come from the real ingested data, so a mismatch is a bug, not a data gap.

## The data these checks assume

| Batch | Sections | Courses (professor differs per section) | Electives (whole batch) |
|---|---|---|---|
| B.Tech IT Sem 5 | A, B (splits B1/B2 for IVP), C | IML, IVP, CS, AI, DTI | CE, BPM |
| B.Tech EC Sem 5 | D | DC, DSP, ESD, ME | AIML, CE, DTI, EM, SSD |

- **IT Sec C** = 62 IIT students (rolls 215–276) **and** 46 IIB students (rolls 1–46, B.Tech BI), all with names.
- **IT Sec A / B** come from roll ranges only (1–107, 108–214), so they have no names.
- **EC Sec D** = 131 students from an uploaded list.
- **Sections share a course but not a professor:** IML is Dr. Naveen Saini (A), Prof. Krishna P. Singh (B), Dr. Shiv Ram Dubey (C). IVP's Prof. Vrijendra Singh teaches **B2 and C**.

## Starting state (2026-09-20, 12:30)

- CR of IT Sem 5 Sec C: **IIT2024245**. No other section has a CR.
- Timetable changes: **none**. Enrollments: **none**.

## Accounts

| Who | Email | Notes |
|---|---|---|
| Student / CR | `iit2024245@iiita.ac.in` | already CR of Sec C |
| Admin | `test-admin@iiita.ac.in` | in the Cognito ADMIN group |
| A second Sec C student | e.g. `iit2024250@iiita.ac.in` | **create it** — needed for checks 9–11 |
| A BI student | e.g. `iib2024001@iiita.ac.in` | **create it** — check 12 |

Passwords and the `admin-create-user` commands are in `TEST_ACCOUNTS.md` (local, not in the repo).

---

## A. Student view (sign in as `iit2024245`)

1. [ ] **Timetable loads** — header reads "B.Tech IT Sem 5 Sec C", no error, no endless "Loading…".
2. [ ] **This week / Next week** are the only week buttons, and switching changes the dates in the day column.
3. [ ] **Classes match the real timetable** — e.g. Thu has IML 11:00–13:00 and IML (P) 14:30–16:30; Fri has IVP 09:00–11:00.
4. [ ] **Free hours are green** with no button needed.
5. [ ] **Electives appear** (CE, BPM) marked "Elective", with a note that registrations aren't uploaded.
6. [ ] **My Batch** lists Sections A, B and C of this batch only, shows Sec C's CR as IIT2024245, and your own roll is highlighted.
7. [ ] **My Batch shows no other batch** (no EC, no Sem 3).

## B. CR actions (same login — it holds Sec C)

8. [ ] **Cancel a class**: click Thu's IML → "Cancel on Thu …" → it goes struck through, its hour turns green, and the change is listed under "What changed" with your roll.
9. [ ] **Undo** from that list restores the class, and the entry stays, struck through, as undone.
10. [ ] **Extra class**: click a green hour → pick IML → it says "For Sec C" → add. It appears on the grid labelled "Extra class · IIT2024245".
11. [ ] **A change reaching two sections**: Make a change → Extra class → **IVP** → it pre-selects **B2 and C** (same professor), not A.
12. [ ] **Move a class**: Make a change → Move → IML → pick an occurrence → the finder offers dated slots → "Move here". The old date shows "Moved away", the new one "Moved here", as one entry in the list.
13. [ ] **The finder names the professor** ("Dr. Shiv Ram Dubey is free") and suggests a room.
14. [ ] **The no-slot case**: Make a change → Extra class → IVP → set the window to 09:00–12:00 with 2 hours → it explains which section or professor blocks it.
15. [ ] **Dates are limited** to this week and next; nothing further ahead is offered.
16. [ ] **Past hours can't be used** — clicking a green hour earlier today/this week says the date has passed.

## C. Another student in the same section (`iit2024250`)

17. [ ] Their timetable shows **the changes IIT2024245 made**, with that roll named.
18. [ ] "What changed" marks them **new**, and **Mark as seen** clears the highlight (and stays cleared after a reload).
19. [ ] They have **no Make a change tab**, and the CR bar says the CR is IIT2024245.

## D. A BI student in the same section (`iib2024001`)

20. [ ] Signs in and sees **Sec C's timetable** (this was broken before roll prefixes were kept).
21. [ ] Their roll shows as **IIB2024001** in My Batch, not IIT2024001.

## E. Admin (`test-admin`)

22. [ ] **Students** tab → pick B.Tech IT Sem 5: the table lists Name, Roll, Section, sorted by name, ~260 rows.
23. [ ] **Section filter**: A ≈ 107, B ≈ 107, C = 108 (62 IIT + 46 IIB). Searching "ABHISHEK" finds the IIB student.
24. [ ] **Source filter**: "Uploaded list only" shows names; "Roll range only" shows the unnamed A/B rolls.
25. [ ] **Download CSV** gives exactly the filtered, sorted rows.
26. [ ] **Class Reps** tab lists Sec C → IIT2024245, with Revoke.
27. [ ] **Activity** tab lists every change made in section B above, with who and when, filterable by batch.
28. [ ] **Enrollments** tab: paste `IIT2024250,IML,DROP,BTech,IT,5,` → it validates → save → it appears in the list. That student's timetable then has no IML. **Delete it afterwards.**
29. [ ] **Correct Timetable** and **Upload Data** still open without errors.

## F. Permissions (the part that must not be wrong)

30. [ ] `iit2024250` **cannot** claim CR for Sec C ("already has a CR").
31. [ ] After the admin **revokes** Sec C's CR, `iit2024250` can claim it, and IIT2024245 loses the Make a change tab. *(Re-claim as IIT2024245 afterwards to restore the starting state.)*
32. [ ] A CR of Sec C **cannot** change Sec A's classes: their course list only offers courses their own section takes.
33. [ ] **CloudWatch shows the decisions** — for the video and as proof:
      `aws logs tail /aws/lambda/amplify-slate-kavyan2-san-sectionchangeslambdaB78D-5jYgBZhyLGrP --since 30m --profile slate --region ap-south-1 | grep cedar`
      Expect `"cedar":"allow"` for the CR's actions and `"cedar":"deny"` for the refused ones.

## G. Leave it clean for the demo

34. [ ] Undo every test change (or delete the rows), so "What changed" is empty.
35. [ ] Delete test enrollments.
36. [ ] Sec C's CR is IIT2024245 again.

---

### If something fails

Note the account, the tab, and the exact message. The two failure modes seen so far were **"your roll number isn't in the uploaded lists"** (the server couldn't resolve the login to a section) and **a screen stuck on "Loading…"** (a request failed and the screen didn't say so). Both now show a real error message instead.
