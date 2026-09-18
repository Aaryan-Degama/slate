import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type TimetableSlotRow = {
  program: string
  branch: string
  section: string
  semester: number
  courseId: string
  faculty?: string | null
}
const listTimetableSlots = () => listAll<TimetableSlotRow>(client.models.TimetableSlot.list)

type RollRangeRow = {
  admissionYear: string
  program: string
  branch: string
  semester: number
  minRoll: number
  maxRoll: number
  section: string
}
const listRollRanges = () => listAll<RollRangeRow>(client.models.RollRange.list)
const createRollRange = client.models.RollRange.create as unknown as (
  input: RollRangeRow,
) => Promise<{ data: RollRangeRow | null; errors?: { message: string }[] }>

type Summary = {
  semester: number
  program: string
  branch: string
  section: string
  classes: number
}

// A "split" section like B1/B2 shares a parent letter (B) with a plain
// section the roll-range table already covers as a whole. Matches B1, B2,
// C3, etc. -- one or more letters followed by a digit.
const SPLIT_RE = /^([A-Za-z]+)(\d+)$/

type Gap = {
  program: string
  branch: string
  semester: number
  parent: string
  subsections: string[]
}

export default function AdminDashboard() {
  const [rows, setRows] = useState<TimetableSlotRow[] | null>(null)
  const [rollRanges, setRollRanges] = useState<RollRangeRow[] | null>(null)
  const [uploadFor, setUploadFor] = useState<Gap | null>(null)

  const reload = () => {
    listTimetableSlots().then(({ data }) => setRows(data))
    listRollRanges().then(({ data }) => setRollRanges(data))
  }

  useEffect(() => {
    reload()
  }, [])

  if (!rows || !rollRanges) return <p>Loading...</p>

  const totalCourses = new Set(rows.map((r) => r.courseId)).size
  const totalFaculty = new Set(rows.map((r) => r.faculty).filter(Boolean)).size
  const semesters = new Set(rows.map((r) => r.semester)).size

  const bySection = new Map<string, Summary>()
  for (const r of rows) {
    const key = `${r.semester}|${r.program}|${r.branch}|${r.section}`
    const existing = bySection.get(key)
    if (existing) {
      existing.classes += 1
    } else {
      bySection.set(key, {
        semester: r.semester,
        program: r.program,
        branch: r.branch,
        section: r.section,
        classes: 1,
      })
    }
  }
  const summaryRows = [...bySection.values()].sort(
    (a, b) => a.semester - b.semester || a.section.localeCompare(b.section),
  )

  // Gap detection: find every split section (B1, B2, ...) that appears in
  // real TimetableSlot data for a batch, then check whether RollRange has
  // a row for that EXACT sub-section. If not, a student can't be resolved
  // into B1 vs B2 -- that's the prompt.
  const gaps: Gap[] = []
  {
    const splitsByBatch = new Map<string, Map<string, Set<string>>>()
    for (const r of rows) {
      const m = SPLIT_RE.exec(r.section)
      if (!m) continue
      const [, parent] = m
      const batchKey = `${r.program}|${r.branch}|${r.semester}`
      let parents = splitsByBatch.get(batchKey)
      if (!parents) {
        parents = new Map()
        splitsByBatch.set(batchKey, parents)
      }
      let subs = parents.get(parent)
      if (!subs) {
        subs = new Set()
        parents.set(parent, subs)
      }
      subs.add(r.section)
    }
    for (const [batchKey, parents] of splitsByBatch) {
      const [program, branch, semesterStr] = batchKey.split('|')
      const semester = Number(semesterStr)
      for (const [parent, subs] of parents) {
        const covered = new Set(
          rollRanges
            .filter((rr) => rr.program === program && rr.branch === branch && rr.semester === semester)
            .map((rr) => rr.section),
        )
        const missing = [...subs].filter((s) => !covered.has(s))
        if (missing.length > 0) {
          gaps.push({ program, branch, semester, parent, subsections: missing.sort() })
        }
      }
    }
  }

  return (
    <div className="dashboard">
      <h1>Ingested Data</h1>
      <p className="subtitle">
        Real timetable data currently loaded into the system. Add or update a batch from the
        Upload Timetable tab; roll-number sub-section ranges (below) can be uploaded here.
      </p>

      {gaps.length > 0 && (
        <div className="card gap-warning" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2>Missing sub-section roll ranges</h2>
          <p className="subtitle">
            These batches split a section into sub-sections in the real timetable, but
            there's no roll-range data saying which students are in which half — those students'
            dashboards can't show these classes yet.
          </p>
          {gaps.map((g) => (
            <div
              key={`${g.program}-${g.branch}-${g.semester}-${g.parent}`}
              className="gap-row"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span>
                {g.program} {g.branch}, Sem {g.semester} — Section {g.parent} splits into{' '}
                {g.subsections.join(', ')}
              </span>
              <button type="button" onClick={() => setUploadFor(g)}>
                Upload roll ranges
              </button>
            </div>
          ))}
        </div>
      )}

      {uploadFor && (
        <RollRangeUpload
          gap={uploadFor}
          onDone={() => {
            setUploadFor(null)
            reload()
          }}
          onCancel={() => setUploadFor(null)}
        />
      )}

      <div className="admin-stats">
        <div className="stat-tile">
          <div className="value">{rows.length}</div>
          <div className="label">Timetable rows</div>
        </div>
        <div className="stat-tile">
          <div className="value">{semesters}</div>
          <div className="label">Semesters covered</div>
        </div>
        <div className="stat-tile">
          <div className="value">{totalCourses}</div>
          <div className="label">Distinct courses</div>
        </div>
        <div className="stat-tile">
          <div className="value">{totalFaculty}</div>
          <div className="label">Faculty identified</div>
        </div>
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Semester</th>
            <th>Program</th>
            <th>Branch</th>
            <th>Section</th>
            <th>Classes</th>
          </tr>
        </thead>
        <tbody>
          {summaryRows.map((s) => (
            <tr key={`${s.semester}-${s.program}-${s.branch}-${s.section}`}>
              <td>{s.semester}</td>
              <td>{s.program}</td>
              <td>{s.branch}</td>
              <td>{s.section}</td>
              <td>{s.classes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type ParsedRow = {
  admissionYear: string
  minRoll: number
  maxRoll: number
  section: string
}

function parseCsv(text: string): { rows: ParsedRow[]; errors: string[] } {
  const rows: ParsedRow[] = []
  const errors: string[] = []
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  for (const [i, line] of lines.entries()) {
    const cols = line.split(',').map((c) => c.trim())
    // Allow a header row (admissionYear,minRoll,maxRoll,section) to be
    // skipped rather than parsed as data.
    if (i === 0 && cols[0].toLowerCase() === 'admissionyear') continue
    if (cols.length !== 4) {
      errors.push(`Line ${i + 1}: expected 4 columns (admissionYear,minRoll,maxRoll,section), got ${cols.length}`)
      continue
    }
    const [admissionYear, minRollStr, maxRollStr, section] = cols
    const minRoll = Number(minRollStr)
    const maxRoll = Number(maxRollStr)
    if (!admissionYear || Number.isNaN(minRoll) || Number.isNaN(maxRoll) || !section) {
      errors.push(`Line ${i + 1}: could not parse "${line}"`)
      continue
    }
    rows.push({ admissionYear, minRoll, maxRoll, section })
  }
  return { rows, errors }
}

function RollRangeUpload({
  gap,
  onDone,
  onCancel,
}: {
  gap: Gap
  onDone: () => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<{ rows: ParsedRow[]; errors: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const handleFile = async (file: File) => {
    const content = await file.text()
    setText(content)
    setParsed(parseCsv(content))
  }

  const handleTextChange = (value: string) => {
    setText(value)
    setParsed(value.trim() ? parseCsv(value) : null)
  }

  const handleSave = async () => {
    if (!parsed || parsed.rows.length === 0) return
    setSaving(true)
    setSaveError('')
    try {
      const results = await Promise.all(
        parsed.rows.map((r) =>
          createRollRange({
            admissionYear: r.admissionYear,
            program: gap.program,
            branch: gap.branch,
            semester: gap.semester,
            minRoll: r.minRoll,
            maxRoll: r.maxRoll,
            section: r.section,
          }),
        ),
      )
      const failed = results.filter((r) => r.errors?.length)
      if (failed.length > 0) {
        throw new Error(failed[0].errors!.map((e) => e.message).join('; '))
      }
      onDone()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2>
        Upload roll ranges — {gap.program} {gap.branch}, Sem {gap.semester}, Section {gap.parent}
      </h2>
      <p className="subtitle">
        A CSV with one row per roll range: <code>admissionYear,minRoll,maxRoll,section</code>.
        Section must be exactly one of: {gap.subsections.join(', ')}. Example:
      </p>
      <pre style={{ background: 'var(--bg-alt, #f4f4f4)', padding: 8, borderRadius: 6, fontSize: 13 }}>
        {`admissionYear,minRoll,maxRoll,section\n2024,108,160,${gap.subsections[0]}\n2024,161,214,${gap.subsections[1] ?? gap.subsections[0]}`}
      </pre>

      <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />

      <textarea
        placeholder="Or paste CSV rows here"
        value={text}
        onChange={(e) => handleTextChange(e.target.value)}
        rows={6}
        style={{ fontFamily: 'monospace', fontSize: 13 }}
      />

      {parsed && (
        <div>
          {parsed.errors.length > 0 && (
            <div className="error">
              {parsed.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
          {parsed.rows.length > 0 && (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Admission year</th>
                  <th>Min roll</th>
                  <th>Max roll</th>
                  <th>Section</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.admissionYear}</td>
                    <td>{r.minRoll}</td>
                    <td>{r.maxRoll}</td>
                    <td>{r.section}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {saveError && <p className="error">{saveError}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="primary"
          disabled={!parsed || parsed.rows.length === 0 || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving...' : `Save ${parsed?.rows.length ?? 0} range(s)`}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  )
}
