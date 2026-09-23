# 16 — Hostile Interview Mode

> Every heading is something you might casually say. Each is followed by the attack it invites and the answer
> that survives it. **Pattern: concede the specific, defend the reasoning, offer the fix.**

---

## "This solves a real problem."

> **⚔ Isn't this just a WhatsApp group with extra steps?**

> "A WhatsApp poll *is* the current tool, and it works for one thing: telling one section 'class cancelled
> tomorrow'. It falls over on the actual hard case — a makeup class that has to work for three sections at once
> plus the professor, where finding one common free hour needs someone to manually cross-reference three or four
> separate timetables. That's the part nobody does well by hand, and it's the part Slate actually computes:
> `find-slots` does interval intersection across every affected section's *effective* timetable and the
> professor's, in milliseconds, with a reason attached to every candidate.
>
> The 'in one place, dated, attributed' part is genuinely just WhatsApp-with-structure, and I won't pretend
> otherwise. But structure is the point — a WhatsApp message can't be queried ('what changed this week'), can't be
> undone with a record, and can't tell you it's free for section B, C and Prof. Sharma simultaneously. The value
> isn't the messaging, it's the constraint-solving underneath it."

---

## "Why not just use a chatbot/LLM for scheduling?"

> **⚔ Everyone's bolting an LLM onto everything — why didn't you?**

> "Because the actual computation needs to be provably correct, not plausible. Finding a slot free for three
> sections and a professor is exact interval math over live data pulled from five DynamoDB tables at call time —
> asking an LLM to do that from a prompt gets you a *plausible-sounding* answer with no guarantee it actually
> checked every clash, which is worse than the current WhatsApp poll because it looks authoritative.
>
> Where an LLM genuinely could help — natural-language input ('find me a slot Tuesday afternoon') as a thin layer
> on top of the deterministic `find-slots` Lambda — we didn't build, because it wasn't the differentiating problem
> in four days. The algorithm and the data model were. I'd add that layer before I'd add an LLM anywhere near the
> actual scheduling decision."

---

## "The CR model empowers students."

> **⚔ What if the CR abuses their power — cancels a class out of spite, or plays favorites?**

> "It's a real risk, and the mitigations are honest but partial, not airtight.
>
> First, scope: a CR can only act on courses their own section takes, with the professor who actually teaches
> their section that course — `policy.cedar`'s `resource.crs.contains(principal)` check is built from real
> `TimetableSlot` data server-side, not anything the client asserts. They can't touch another batch, another
> course, or invent a professor.
>
> Second, attribution: every `ScheduleChange` row records `changedBy` and `changedBySection`, shown to every
> affected student. A CR who cancels a real class out of spite does it with their name attached to every student
> who sees it — that's social accountability, not a technical prevention.
>
> Third, counter-action: another section's CR affected by the same change can Undo it for their own section
> specifically (`UndoSection` in Cedar), even if they didn't make it — so a bad extra class doesn't force everyone
> to eat it.
>
> Fourth, the actual backstop: admins can revoke a CR outright by deleting the `ClassRep` row, and the Admin
> Activity log shows every change across every batch for this week and next.
>
> What it *doesn't* have: no rate limiting on how many changes one CR can make, no automatic flagging of unusual
> patterns, and no way for ordinary students in that section to challenge a change short of finding the CR socially
> or escalating to an admin. That's a real gap for a production version, not something the hackathon scope solved."

---

## "Your ingestion PDF parsing surely doesn't really work."

> **⚔ Prove it. Walk me through what actually happens when you upload a real timetable.**

> "The honest answer, and CLAUDE.md says this plainly rather than hiding it: the fully-automated OCR/AI ingestion
> path (Textract + Bedrock, `scripts/bedrock-normalize-timetable.py`) exists in the repo but **isn't in the live
> path**. What's actually wired into the app is `parse-timetable`'s spreadsheet reader (`reader.ts`), which handles
> real AAA timetable spreadsheets — not raw scanned PDFs — with their genuine mess: merged cells, cohort labels
> like 'All' meaning something structurally different from a named section, and sub-sections (B1/B2) that don't
> follow one consistent pattern across programs.
>
> Where the reader can't confidently map a row, it surfaces that as a validation issue for the admin to resolve by
> hand — it does not silently guess and write bad data. That two-step design (`parseTimetable` returns proposed
> rows + issues; `importData` writes only after admin confirmation, with a `dryRun` flag) exists *because* we
> didn't trust one-shot automated extraction to be reliable enough to skip human review.
>
> So: does the automated path work end to end on a real spreadsheet? Yes, for the structured-spreadsheet case we
> actually built. Does it do OCR on a scanned PDF unaided? No — that was the harder, riskier plan, we said upfront
> we'd fall back to hand-structuring data from real source PDFs if accuracy wasn't provably there, and that's the
> honest state of it."

---

## "The professor tells the CR, so professors are load-bearing but have no accountability in the system."

> **⚔ If a professor lies to the CR about a cancellation, your system just faithfully records the lie. How is that better?**

> "It's not better at catching lies — nothing in this system verifies that a professor actually said what a CR
> claims they said. What it improves is *distribution and traceability* of whatever was agreed, correctly or not.
> Today, if a professor tells a CR the wrong thing, that same wrong thing propagates by word of mouth and WhatsApp
> anyway — Slate doesn't introduce that failure mode, it just makes the propagated claim attributable (this CR,
> this section, this timestamp) instead of an untraceable forwarded message.
>
> If a professor and CR genuinely disagree about what was said, that's a real-world dispute Slate has no
> mechanism to resolve — it was explicitly scoped out (no faculty login, no confirmation step from the professor
> side) because building a two-party confirmation flow was a bigger feature than four days allowed, and it would
> have needed faculty to actually use the app, which wasn't true of this cohort."

---

## "You have hard 'no vector search / no OpenSearch' rules — isn't that just avoiding modern tooling?"

> **⚔ That sounds like a cost excuse dressed up as an architecture decision.**

> "It's genuinely both, and I'd rather say that than pretend it's purely principled. Cost is real: OpenSearch
> doesn't scale to zero, and running one for a hackathon project with no idle-teardown story is money burned for
> nothing used.
>
> But the architectural claim stands on its own regardless of cost: there's no fuzzy-similarity question anywhere
> in this domain. 'Is this timeslot free for section B' is a boolean overlap check on structured rows — a vector
> embedding of a timeslot wouldn't rank anything meaningfully, because there's no graded notion of 'similar
> availability'; it's binary. If we ever added natural-language search over the change feed ('show me changes
> affecting my elective'), that'd be a genuine candidate for embeddings — and we still wouldn't need OpenSearch for
> it at this data volume; DynamoDB scan + filter in Lambda memory is fine at one institution's scale."

---

## "Cedar is overkill for five permission rules — admit it."

> **⚔ You could've written this in five `if` statements. Why the extra dependency?**

> "Fair pressure-test, and I'd concede the rule *count* doesn't demand Cedar — five `if`s would technically work.
> What doesn't reduce to `if` statements cleanly is that each rule's *resource* is built fresh from live,
> server-derived data every call — `resource.crs` for a Course entity is computed from a DynamoDB scan of
> `TimetableSlot` plus `ClassRep`, matched by professor, for that specific course, at that moment. That's not
> complex per rule, but it is genuinely relational (principal-to-resource, not principal-to-static-role), and
> that's exactly the kind of logic that grows unreadable fast if it's inlined as nested conditionals across five
> separate mutation handlers instead of centralized as one declarative policy file anyone can audit without
> tracing control flow.
>
> The concrete payoff we actually used: every Cedar call — allow or deny — logs structured JSON to CloudWatch, and
> that's the exact artifact the demo video shows to prove a non-CR gets denied server-side, not just that a button
> is hidden client-side. That's a genuine security demonstration for a judged category, which five inline `if`s
> wouldn't have produced as cleanly."

---

## "You use DynamoDB Scan everywhere — that doesn't scale."

> **⚔ `scanAll()` reads entire tables into Lambda memory on every request. What happens at real enrollment numbers?**

> "It gets slow and it gets expensive — that's a straightforward, known limitation, not something I'd argue around.
> At one institution's actual scale (a few thousand students, a few hundred timetable rows per semester, a
> handful of live changes at any time) a full scan of any of these tables is milliseconds and effectively free.
> It stops being fine well before 'IIITA-sized', though — probably somewhere in the tens of thousands of rows per
> table, or under sustained concurrent CR activity.
>
> The fix is known and not architecturally disruptive: GSIs keyed by batch (`program|branch|semester`) so
> `section-changes` and `find-slots` query instead of scan, cutting the read set from 'everything' to 'this
> batch's rows'. We didn't build it because at hackathon data volumes it wouldn't have changed anything visible in
> the demo, and every hour on it was an hour not spent on the algorithm or ingestion, which is what's actually
> being judged."

---

## "The demo will show a happy path. What breaks it?"

> **⚔ Show me the actual failure modes you know about.**

> "Three I'd volunteer before being asked:
>
> First, ingestion accuracy on formats we haven't hand-tested — any spreadsheet shape outside what `reader.ts` was
> built and tested against will surface as validation issues rather than silently importing garbage, which is the
> intended behavior, but it does mean 'upload any random timetable' isn't a guaranteed-clean demo without prior
> verification of that specific sheet.
>
> Second, `scanAll()`'s full-table-scan pattern (see the DynamoDB question above) — fine at demo scale, a real
> limitation at institution scale.
>
> Third, the CR-abuse gap above: no rate limiting, no anomaly detection on change volume. All are honest,
> acknowledged scope cuts for a four-day build, not things we're pretending don't exist."

---

## The meta-question

> **⚔ You've just told me several things you didn't build or don't scale. Why should I be impressed?**

> "Because the alternative is you find the gaps and I have no answer, or worse, I claim they don't exist and get
> caught on camera or in the code. Every limitation above is one I can point to a specific file or a specific
> section of CLAUDE.md for — the ingestion honesty point is written into the brief itself (§3), not something I'm
> improvising defensively now.
>
> What I'd want you to take from this isn't a list of cut corners. It's that the one thing genuinely hard here —
> finding a slot that's simultaneously free for several real timetables and a professor, explainably, with a
> reason attached to every candidate — is built for real, tested against real data, and is the part that couldn't
> be faked with a mockup. Everything I've conceded above is scope, not the core claim."
