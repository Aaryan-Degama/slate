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
type StudentSectionRow = { program: string; branch: string; semester: number; subSection?: string | null }
const listStudentSections = () => listAll<StudentSectionRow>(client.models.StudentSection.list)

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

export default function AdminDashboard({ onOpenStudents }: { onOpenStudents: () => void }) {
  const [rows, setRows] = useState<TimetableSlotRow[] | null>(null)
  const [rollRanges, setRollRanges] = useState<RollRangeRow[] | null>(null)
  const [students, setStudents] = useState<StudentSectionRow[] | null>(null)

  const reload = () => {
    listTimetableSlots().then(({ data }) => setRows(data))
    listRollRanges().then(({ data }) => setRollRanges(data))
    listStudentSections().then(({ data }) => setStudents(data))
  }

  useEffect(() => {
    reload()
  }, [])

  if (!rows || !rollRanges || !students) return <p>Loading...</p>

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
        const inBatch = (x: { program: string; branch: string; semester: number }) =>
          x.program === program && x.branch === branch && x.semester === semester
        const covered = new Set([
          ...rollRanges.filter(inBatch).map((rr) => rr.section),
          ...students.filter(inBatch).map((s) => s.subSection ?? ''),
        ])
        const missing = [...subs].filter((s) => !covered.has(s))
        if (missing.length > 0) {
          gaps.push({ program, branch, semester, parent, subsections: missing.sort() })
        }
      }
    }
  }

  return (
    <div className="dashboard">
      <p className="eyebrow">Admin</p>
      <h1>Ingested Data</h1>
      <p className="subtitle">
        Real timetable data currently loaded into the system. Add or update a batch from the
        Upload Data tab (timetables and student lists); roll ranges live on the Students tab.
      </p>

      {gaps.length > 0 && (
        <div className="card gap-warning" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2>Missing sub-section groups</h2>
          <p className="subtitle">
            These batches split a section into sub-sections in the real timetable, but
            nothing says which students are in which group, so those classes can't be shown to them yet.
            Add B1/B2 roll ranges on the Students tab, or upload the student list with its B1/B2 column.
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
              <button type="button" onClick={onOpenStudents}>
                Set on Students tab
              </button>
            </div>
          ))}
        </div>
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
