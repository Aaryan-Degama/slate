import { useState } from 'react'
import { personLabel } from './lib/grid'
import { revokeCr, useClassReps } from './lib/classReps'

/** Every section's CR, with a revoke button (the section can then claim again). */
export default function AdminClassReps() {
  const { reps, reload } = useClassReps()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  if (!reps) return <p>Loading class reps...</p>

  const revoke = async (id: string) => {
    setBusy(id)
    setError('')
    try {
      await revokeCr(id)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke.')
    } finally {
      setBusy(null)
    }
  }

  const sorted = [...reps].sort((a, b) => a.sectionKey.localeCompare(b.sectionKey))
  return (
    <div className="dashboard">
      <h1>Class reps</h1>
      <p>
        Each section's CR claimed the role themselves. Revoking frees the section so another student can claim it; the
        changes they made stay in the history under their name.
      </p>
      {error && <p className="error">{error}</p>}
      {sorted.length === 0 ? (
        <p className="meta">No section has a CR yet.</p>
      ) : (
        <ul className="change-history">
          {sorted.map((r) => (
            <li key={r.id}>
              <span>
                <strong>
                  {r.program} {r.branch} Sem {r.semester} Sec {r.section}
                </strong>{' '}
                · {personLabel(r.email)}
              </span>
              <span className="meta">since {new Date(r.createdAt).toLocaleString()}</span>
              <button type="button" className="danger" disabled={busy !== null} onClick={() => revoke(r.id)}>
                {busy === r.id ? 'Revoking...' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
