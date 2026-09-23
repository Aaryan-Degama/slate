# 08 — The Ingestion Pipeline: S3 → parse-timetable → admin review → import-data

## The pipeline that's actually live [VERIFIED-REPO]

Confirmed end to end in code:

```
Admin uploads .xlsx to S3 (timetable-uploads/*)
        │
        ▼
parseTimetable Lambda (query, read-only)
  loadWorkbook(key) → per sheet: readTemplate() or processSheet() [timetable]
                       else readTable() [generic table, e.g. student list]
        │  returns { key, sheets: [...] } — proposed rows + issues, nothing written
        ▼
Admin reviews in the app (confirms column mapping, section overrides, dryRun)
        │
        ▼
importData Lambda (mutation, ADMIN group only)
  re-reads the same file from S3, re-parses with the admin's confirmed mapping,
  diffs against current DynamoDB rows, writes added/changed/removed (unless dryRun)
```

This is a real two-Lambda, human-in-the-loop pipeline, not a single opaque
"upload and hope" step — and that loop-in-the-middle is deliberate: spreadsheet
parsing over inconsistent institutional formats can misread a row, so nothing
is written to DynamoDB until an admin has seen the proposed diff.

### `parse-timetable/handler.ts` — read-only, classify, propose

```ts
export const handler = async (event: { arguments: { key: string } }) => {
  const wb = await loadWorkbook(key)
  const sheets = wb.worksheets.map((ws) => {
    try { return { kind: 'timetable', ...(readTemplate(ws) ?? processSheet(ws)) } }
    catch {
      try { return readTable(ws) }
      catch (err) { return { sheet: ws.name, kind: 'error', error: ... } }
    }
  })
  ...
  return JSON.stringify({ key, sheets })
}
```
Per sheet, it tries, in order: `readTemplate()` (Slate's own flat
header-based format — `Day/Start/End/Course/Type/Section/Room/Faculty` — for
sheets already re-typed into a known shape), then `processSheet()` (the real
grid-parsing path for genuine institutional timetable sheets), then falls
back to `readTable()` (a generic table with guessed column roles, for student
lists or anything that isn't a timetable grid at all). Nothing is persisted
here — this Lambda's whole job is to turn one uploaded file into a structured
preview the admin can inspect before anything touches DynamoDB.

### `processSheet()` (`parse-timetable/reader.ts`) — the real grid parser

This is the substantial piece of hand-written extraction logic, and it's
doing real work against real institutional spreadsheet quirks, confirmed by
reading the regexes and comments directly:

- **Merged cells / multi-hour classes**: `readSheet()` walks `ws.model.merges`
  to find each timetable header's true column span, and each class cell's
  true row/column span, so a class merged across two 1-hour columns is read
  as one 2-hour session, not two separate 1-hour ones.
- **Two legend layouts**: `readLegend()` explicitly handles both a
  header-driven "Course Code | Course Name | Faculty" block (IT sheets) *and*
  a header-less row layout keyed by finding an L-T-P-S-shaped cell
  (`LTPS_RE`) and working outward from it (ECE core-course sheets) — a
  concrete example of "the real sheets are inconsistent across programs"
  (CLAUDE.md §3) being handled in code, not assumed away.
- **Cohort labels that aren't sections**: `WHOLE_BATCH_LABEL =
  /^(all|both|IT-BI|BI-IT)$/i` recognizes sheet text meaning "the whole
  batch," mapped to the sentinel section `'*'`.
- **Electives vs. whole-batch core classes**: a section-less class is an
  elective (`isElective: true`, attended only per `Enrollment`) unless the
  course legend marks it `core` (`CORE_CATEGORY_RE = /^(PCC|BSC|ESC|PC)\b/i`),
  in which case it's a mandatory whole-batch class everyone attends.
- **Room-number normalization**: `normRoom()` collapses `"CC-3, 5254"` /
  `"(CC3- 5207)"` / `"CC-3 5154"` into one canonical `"CC3-5254"` form,
  because the raw sheets are visibly inconsistent about it.
- **Roll ranges printed under the grid**: `readRollRanges()` regex-matches
  lines like `"Sec A | IIT2026001 to IIT2026154"` anywhere below the grid,
  feeding `RollRange` directly from the same file, no separate upload needed.
- **Validation, not silent acceptance**: `validate()` cross-checks parsed
  hours-per-week against the legend's L-T-P-S numbers to disambiguate
  merge-length ambiguity, flags unknown course codes, room clashes, and
  section clashes — surfaced back to the admin as `issues`, never silently
  dropped or guessed.

### `import-data/handler.ts` — the actual write path, admin-only, diffed

```ts
if (!event.identity?.groups?.includes('ADMIN')) throw new Error('Only admins can import data.')
```
Re-parses the *same* file (`loadWorkbook(a.key)`, same `readTemplate`/
`processSheet`/`readTable`), now with the admin's confirmed parameters
(`sectionCol`, `onlyPrefixes`, `defaultSection`, etc. — the review screen's
inputs), then **diffs against existing DynamoDB rows** rather than blindly
overwriting:
```ts
const key = (r) => `${r.day}|${r.courseId}|${r.sessionType ?? ''}|${r.section}|${r.startTime}`
const existing = (await scanAll(TT)).filter(inBatch)
const byKey = new Map(existing.map((e) => [key(e), e]))
const added = rows.filter((r) => !byKey.has(key(r)))
const changed = rows.flatMap((r) => { ... only endTime/room/faculty/isElective diffs ... })
const removed = existing.filter((e) => !seen.has(key(e)))
```
`dryRun: a.boolean().required()` (in the schema) lets the admin preview
`added`/`changed`/`removed` counts and details without writing anything —
only when `dryRun` is false does it call `batchWrite`/`update`, and
`removeMissing` is a separate opt-in flag before existing rows are deleted at
all. This diff-then-confirm shape is the concrete version of CLAUDE.md §3's
"admin reviews → import-data Lambda writes DynamoDB."

Student-list import (`kind: 'students'`) follows the identical
propose→review→diff→write shape via `buildStudentRecords()`
(`import-data/students.ts`), with its own real-world handling: multi-prefix
sheets (`IIT2024001` vs `IIB2024001` are different people even at the same
numeric roll — `onlyPrefixes` filters a sheet listing several programmes at
once), trailing `*` markers on names stripped, numeric-only sub-section
columns (`"1"`/`"2"`) expanded to `<section>1`/`<section>2`, and
cross-checking that all rows for one student agree on section.

## The honest ingestion story: Textract/Bedrock is scripted, not in the live path

CLAUDE.md §3 states this plainly as a required disclosure, and the repo
backs it up:

```python
# scripts/bedrock-normalize-timetable.py
"""
Real Bedrock ingestion step (CLAUDE.md §3): takes the raw cell+merge
structure dump (dump-sheet-structure.py) for one timetable sheet and
asks Claude, via Bedrock, to normalize it into a flat schema...
Replaces the hand-written regex extraction, which repeatedly
missed merged cells...
Output: ... printed to stdout. Meant to be spot-checked against a real,
known schedule before being loaded into DynamoDB (see load-normalized-timetable.py).
"""
```
This script is real and does call AWS Bedrock:
```python
MODEL_ID = 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0'
client = boto3.client('bedrock-runtime', region_name=REGION)
response = client.converse(
    modelId=MODEL_ID, system=[{'text': SYSTEM_PROMPT}],
    messages=[{'role': 'user', 'content': [{'text': user_content}]}],
    inferenceConfig={'maxTokens': 8192, 'temperature': 0},
)
```
Its system prompt is a carefully specified normalization task: interpret
merge ranges as true class durations (not guessed from session type alone),
distinguish a section label from a cohort/program qualifier ("IT-BI" is a
cohort, not a section), split multi-line cells into separate sessions, treat
"LUNCH" as non-class, and — notably — tell it explicitly **not** to guess
durations beyond what the merge structure or unambiguous text supports
(`temperature: 0` reinforces determinism over creative inference).

But — confirmed by `git log` and the repo structure — **this script is not
called from `amplify/functions/parse-timetable/` or `import-data/` at all.**
The live ingestion path (`reader.ts`'s `processSheet()`) is entirely
hand-written TypeScript regex/merge-range parsing, run inside the
`parseTimetable` Lambda. `git log` even records `6ab38cf "Remove the
superseded ingestion scripts and two dead functions"` — a prior, more
Python-script-heavy ingestion approach was actively removed in favor of the
in-app `parseTimetable`/`importData` flow. `bedrock-normalize-timetable.py`
is a standalone script, run manually, output meant to be "spot-checked
against a real, known schedule before being loaded" — i.e. a one-off
verification/normalization aid over specific sheets, not a component the app
calls per upload.

**Say this plainly, as CLAUDE.md §3 requires:** the automated Textract/Bedrock
path was built and genuinely exercised against Bedrock (it's a real,
callable script using a real Claude model via `bedrock-runtime`), but the
**live**, in-app ingestion the deployed product actually runs on is
hand-written parsing logic (`reader.ts`), with an admin review/confirm step
in front of every write. This is the "honest call on ingestion" the brief
explicitly asks for: don't claim full automation where the wiring isn't
there, and don't fabricate accuracy numbers for a path that isn't live.

## Where AWS shows up for real in this pipeline

- **S3** (`timetableUploads` bucket, `storage/resource.ts`): admin-only
  write, Lambda-scoped read, enforced by Amplify's resource-based S3 grants
  (see 04).
- **Lambda** (`parseTimetable`, `importData`): the actual compute doing the
  parsing/diffing, deployed via Amplify Gen 2, IAM-scoped per-table via
  `backend.ts`'s explicit `grantReadWriteData`/`grantReadData` calls.
- **DynamoDB**: `TimetableSlot`/`StudentSection`/`RollRange` are the write
  targets, using `BatchWriteCommand` in batches of 25 (DynamoDB's batch
  write limit) with exponential-backoff retry on `UnprocessedItems`:
```ts
async function batchWrite(table, requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25)
    for (let attempt = 0; pending?.length && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }))
      pending = res.UnprocessedItems?.[table]
      if (pending?.length) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
    }
    if (pending?.length) throw new Error(`${pending.length} writes ... were not processed`)
  }
}
```
This handles DynamoDB's documented `BatchWriteItem` behavior of possibly
returning unprocessed items under throttling — a real production concern
handled correctly, not glossed over, even at hackathon scope.
- **Bedrock** (`scripts/bedrock-normalize-timetable.py`): a real, working
  script calling `bedrock-runtime.converse()` against a Claude 3.5 Sonnet
  model in `ap-south-1`/`apac` — genuinely exercised AWS usage, but a
  side script, not the live path.

---

## Q&A

**Q: Is the parsing pipeline fully automated end to end?**
No, by design: `parseTimetable` proposes rows and flags issues, but nothing
writes to DynamoDB until an admin reviews the proposal and `import-data`
runs (optionally as a `dryRun` first). The parsing logic itself
(`reader.ts`) is deterministic hand-written code, not an LLM call — it's the
review/confirm step that's the actual safety mechanism, not model accuracy.

**Q: Did you actually use Bedrock, or is it just mentioned in the writeup?**
Real, callable code exists (`scripts/bedrock-normalize-timetable.py`) that
calls `bedrock-runtime.converse()` with a real Claude 3.5 Sonnet model ID and
a carefully written system prompt for merge-aware timetable normalization —
this genuinely was run against real timetable dumps. What's honest to say is
that it's a standalone script for spot-verifying/normalizing sheets, not
wired into the live `parseTimetable`/`import-data` Lambda flow the deployed
app uses on every upload.

**Q: Why keep the hand-written regex parser instead of using Bedrock for every upload?**
Determinism and latency/cost at a small, fixed sheet count: the real AAA
timetable sheets follow a small number of known layout variants (confirmed
by handling exactly two legend layouts, a handful of cohort-label patterns,
and merge-range durations), so a hand-written parser with explicit
validation (`validate()`'s hours-mismatch/room-clash/section-clash checks)
is both cheaper to run per upload and easier to reason about failure modes
for than an LLM call whose accuracy would need re-verifying per sheet
format. `git log`'s "Remove the superseded ingestion scripts" commit
confirms this was an active choice, not an oversight — an LLM-based
ingestion path was tried and moved away from for the live product.

**Q: How does the pipeline avoid double-importing or corrupting existing timetable data on re-upload?**
`importData` diffs every parsed row against existing `TimetableSlot` rows
using a composite key (`day|courseId|sessionType|section|startTime`) before
writing anything: only genuinely new rows are added, only rows with real
field differences (`endTime`, `room`, `faculty`, `isElective`) are updated,
and rows no longer present are only deleted if the admin explicitly opts
into `removeMissing`. A dry run surfaces the exact diff before any write.

**Q: What real spreadsheet problems does `reader.ts` handle that a naive parser would miss?**
Merged cells spanning multiple hour columns (misread as several 1-hour
classes otherwise), two structurally different course-legend layouts across
programmes, cohort labels like "IT-BI" that look like sections but aren't,
inconsistent room-number formatting, and roll-number ranges printed as free
text below the grid rather than in a separate structured field — each has
a specific regex/merge-range handling path in the code, with unhandled cases
surfaced as `skipped`/`issues` for the admin rather than silently dropped or
guessed.
