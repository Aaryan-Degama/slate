import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type StudentRow = {
  admissionYear: string
  rollNumber: number
  program: string
  branch: string
  semester: number
  section: string
  subSection?: string | null
  updatedAt?: string
}
type RangeRow = { admissionYear: string; program: string; branch: string; semester: number; minRoll: number; maxRoll: number; section: string }

/** Section-wise student list per batch: uploaded lists (StudentSection) plus any roll ranges. */
export default function AdminStudents() {
  const [students, setStudents] = useState<StudentRow[] | null>(null)
  const [ranges, setRanges] = useState<RangeRow[]>([])
  const [batchKey, setBatchKey] = useState('')

  useEffect(() => {
    listAll<StudentRow>(client.models.StudentSection.list).then(({ data }) => setStudents(data))
    listAll<RangeRow>(client.models.RollRange.list).then(({ data }) => setRanges(data))
  }, [])

  const batches = useMemo(() => {
    const keys = new Map<string, { program: string; branch: string; semester: number }>()
    for (const r of [...(students ?? []), ...ranges]) keys.set(`${r.program}|${r.branch}|${r.semester}`, r)
    return [...keys.entries()].sort((a, b) => a[1].semester - b[1].semester)
  }, [students, ranges])

  useEffect(() => {
    if (!batchKey && batches.length) setBatchKey(batches[0][0])
  }, [batches, batchKey])

  if (!students) return <p>Loading...</p>

  const inBatch = (r: { program: string; branch: string; semester: number }) =>
    `${r.program}|${r.branch}|${r.semester}` === batchKey
  const mine = students.filter(inBatch)
  const myRanges = ranges.filter(inBatch).sort((a, b) => a.section.localeCompare(b.section))
  const sections = [...new Set(mine.map((s) => s.section))].sort()
  const lastUpdate = mine.map((s) => s.updatedAt ?? '').sort().at(-1)

  return (
    <div className="dashboard">
      <h1>Students</h1>
      <p className="subtitle">
        Who is in which section, from uploaded student lists. Add or change them from Upload Data.
      </p>

      {batches.length === 0 ? (
        <p>No student lists or roll ranges yet.</p>
      ) : (
        <div className="option-list">
          {batches.map(([k, b]) => (
            <button key={k} className={k === batchKey ? 'active' : ''} onClick={() => setBatchKey(k)}>
              {b.program} {b.branch} — Semester {b.semester}
            </button>
          ))}
        </div>
      )}

      {batchKey && (
        <>
          <p className="meta">
            {mine.length} students from uploaded lists
            {lastUpdate ? ` · last updated ${new Date(lastUpdate).toLocaleString()}` : ''}
          </p>

          {sections.map((sec) => {
            const inSec = mine.filter((s) => s.section === sec)
            const groups = [...new Set(inSec.map((s) => s.subSection ?? ''))].sort()
            return (
              <div key={sec} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h2>
                  Section {sec} · {inSec.length} students
                </h2>
                {groups.map((g) => {
                  const list = inSec.filter((s) => (s.subSection ?? '') === g).sort((a, b) =>
                    a.admissionYear.localeCompare(b.admissionYear) || a.rollNumber - b.rollNumber,
                  )
                  return (
                    <div key={g || 'none'}>
                      <strong>{g ? `${g} · ${list.length}` : groups.length > 1 ? `No sub-section · ${list.length}` : ''}</strong>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                        {list.map((s) => (
                          <span key={`${s.admissionYear}-${s.rollNumber}`} className="meta" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {s.admissionYear}·{String(s.rollNumber).padStart(3, '0')}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}

          {myRanges.length > 0 && (
            <div className="card">
              <h2>Roll ranges</h2>
              <p className="subtitle">Used for students who aren't in an uploaded list.</p>
              <table className="admin-table">
                <tbody>
                  {myRanges.map((r) => (
                    <tr key={`${r.admissionYear}-${r.section}-${r.minRoll}`}>
                      <td>Section {r.section}</td>
                      <td>
                        {r.admissionYear}: rolls {r.minRoll}–{r.maxRoll}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
