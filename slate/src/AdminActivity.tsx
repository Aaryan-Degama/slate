import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import ActionLine from './components/ActionLine'
import { toActions, type ChangeRow } from './lib/changes'
import { addDays, mondayOf, todayIst } from './lib/grid'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

/** Every timetable change across batches: who did what, when, and whether it was undone. */
export default function AdminActivity() {
  const [rows, setRows] = useState<ChangeRow[] | null>(null)
  const [error, setError] = useState('')
  const [batch, setBatch] = useState('')

  useEffect(() => {
    listAll<ChangeRow>(client.models.ScheduleChange.list)
      .then(({ data }) => setRows(data.filter((r) => r.date)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // This week and next only; older changes are deleted by the table's TTL.
  const actions = useMemo(() => {
    const monday = mondayOf(todayIst())
    return rows ? toActions(rows).filter((a) => a.date >= monday && a.date <= addDays(monday, 11)) : []
  }, [rows])
  const batches = useMemo(() => [...new Set(actions.map((a) => a.batch))].sort(), [actions])

  if (error) return <p className="error">Couldn't load changes: {error}</p>
  if (!rows) return <p>Loading activity...</p>

  const shown = batch ? actions.filter((a) => a.batch === batch) : actions
  return (
    <div className="dashboard">
      <h1>Activity</h1>
      <p>Every change CRs (or admins) made for this week and next, newest first. Undone changes stay listed with who undid them.</p>
      <label>
        Batch{' '}
        <select value={batch} onChange={(e) => setBatch(e.target.value)}>
          <option value="">All batches ({actions.length})</option>
          {batches.map((b) => (
            <option key={b} value={b}>
              {b} ({actions.filter((a) => a.batch === b).length})
            </option>
          ))}
        </select>
      </label>
      {shown.length === 0 ? (
        <p className="meta">No changes yet.</p>
      ) : (
        <ul className="change-history">
          {shown.map((a) => (
            <ActionLine key={a.groupId} action={a} showBatch />
          ))}
        </ul>
      )}
    </div>
  )
}
