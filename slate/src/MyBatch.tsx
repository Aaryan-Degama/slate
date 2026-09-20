import { useEffect, useState } from 'react'
import StudentTable, { buildStudentRows } from './components/StudentTable'
import { fetchBatchRoster, type BatchRoster } from './lib/rollLookup'

/** Section-wise class list for the student's own batch: the same table the
 * admin sees, limited to their batch (the server never returns another). */
export default function MyBatch() {
  const [roster, setRoster] = useState<BatchRoster | null | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchBatchRoster()
      .then(setRoster)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  if (error) return <p className="error">Couldn't load your batch: {error}</p>
  if (roster === undefined) return <p>Loading your batch...</p>
  if (roster === null)
    return <p className="error">Your roll number isn't in the uploaded student lists, so your batch isn't known yet. Ask your admin.</p>

  const students = roster.sections.flatMap((s) =>
    s.students.map((st) => ({
      admissionYear: st.id.slice(-7, -3),
      rollNumber: Number(st.id.slice(-3)),
      rollPrefix: st.id.slice(0, -7),
      name: st.name ?? '',
      branch: roster.branch,
      section: s.section,
      subSection: st.subSection,
    })),
  )
  const ranges = roster.sections.flatMap((s) => s.ranges)
  const crByRollId = Object.fromEntries(roster.sections.filter((s) => s.cr).map((s) => [s.cr!.email.split('@')[0].toUpperCase(), s.section]))

  return (
    <div className="dashboard">
      <p className="eyebrow">Your Batch</p>
      <h1>
        My Batch — {roster.program} {roster.branch} Sem {roster.semester}
      </h1>
      <p className="meta">
        You're in Sec {roster.me}. Everyone in your batch, section by section — only this batch, and only students can see it.
      </p>
      <div className="option-list">
        {roster.sections.map((s) => (
          <span key={s.section} className="meta">
            Sec {s.section}: CR {s.cr ? s.cr.email.split('@')[0].toUpperCase() : 'none yet'}
          </span>
        ))}
      </div>
      <StudentTable
        rows={buildStudentRows(students, ranges, roster.branch)}
        fileName={`${roster.program}-${roster.branch}-sem${roster.semester}-batch`}
        meRollId={roster.meRollId}
        crByRollId={crByRollId}
      />
    </div>
  )
}
