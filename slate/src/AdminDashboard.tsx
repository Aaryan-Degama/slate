import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'

const client = generateClient<Schema>()

type TimetableSlotRow = {
  program: string
  branch: string
  section: string
  semester: number
  courseId: string
  faculty?: string | null
}
const listTimetableSlots = client.models.TimetableSlot.list as unknown as () => Promise<{
  data: TimetableSlotRow[]
}>

type Summary = {
  semester: number
  program: string
  branch: string
  section: string
  classes: number
}

export default function AdminDashboard() {
  const [rows, setRows] = useState<TimetableSlotRow[] | null>(null)

  useEffect(() => {
    listTimetableSlots().then(({ data }) => setRows(data))
  }, [])

  if (!rows) return <p>Loading...</p>

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

  return (
    <div className="dashboard">
      <h1>Ingested Data</h1>
      <p className="subtitle">
        Real timetable data currently loaded into the system. There's no upload screen yet —
        new data is hand-ingested from official spreadsheets/PDFs directly into the database.
      </p>

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
