import { useEffect, useState } from 'react'
import { personLabel } from './lib/grid'
import { fetchBatchRoster, type BatchRoster } from './lib/rollLookup'

/** Section-wise class list for the student's own batch: each section's CR and students. */
export default function MyBatch({ email }: { email: string }) {
  const [roster, setRoster] = useState<BatchRoster | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    fetchBatchRoster()
      .then((r) => {
        setRoster(r)
        const mine = r?.me[0]
        if (mine) setOpen(mine)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  if (error) return <p className="error">Couldn't load your batch: {error}</p>
  if (roster === undefined) return <p>Loading your batch...</p>
  if (roster === null)
    return <p className="error">Your roll number isn't in the uploaded student lists, so your batch isn't known yet. Ask your admin.</p>

  const me = personLabel(email)
  return (
    <div className="dashboard">
      <h1>
        My Batch — {roster.program} {roster.branch} Sem {roster.semester}
      </h1>
      <p className="meta">You're in Sec {roster.me}. Only students of this batch can see this list.</p>
      <ul className="change-history">
        {roster.sections.map((s) => (
          <li key={s.section}>
            <span>
              <strong>Sec {s.section}</strong> · {s.students.length ? `${s.students.length} students` : 'no student list uploaded'} · CR:{' '}
              {s.cr ? personLabel(s.cr.email) : 'none yet'}
            </span>
            {(s.students.length > 0 || s.ranges.length > 0) && (
              <button type="button" onClick={() => setOpen(open === s.section ? null : s.section)}>
                {open === s.section ? 'Hide' : 'Show students'}
              </button>
            )}
            {open === s.section && (
              <div className="roster">
                {s.students.length > 0 ? (
                  s.students.map((st) => (
                    <span key={st.id} className={`roll${st.id === me ? ' me' : ''}${s.cr && personLabel(s.cr.email) === st.id ? ' cr' : ''}`}>
                      {st.id}
                      {st.subSection ? ` · ${st.subSection}` : ''}
                      {s.cr && personLabel(s.cr.email) === st.id ? ' · CR' : ''}
                    </span>
                  ))
                ) : (
                  <span className="meta">
                    Rolls{' '}
                    {s.ranges
                      .map((r) => `${r.minRoll}–${r.maxRoll}${r.section.length === 2 ? ` (${r.section})` : ''} of ${r.admissionYear}`)
                      .join(', ')}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
