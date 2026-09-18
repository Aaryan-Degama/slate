import { useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import { uploadData } from 'aws-amplify/storage'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, type BusyEntry } from './lib/grid'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type ParsedRow = {
  program: string | null
  branch: string | null
  semester: number | null
  day: string
  startTime: string
  endTime: string
  courseId: string
  sessionType: string
  section: string
  room: string
  faculty: string | null
  source: string
  duration: string
}
type Issue = { type: string; detail?: string; course?: string; section?: string; kind?: string; row?: string; rows?: string[] }
type SheetResult =
  | {
      sheet: string
      title: string
      batch: { program: string | null; branch: string | null; semester: number | null }
      rows: ParsedRow[]
      skipped: { coord: string; day: string; text: string; reason: string }[]
      issues: Issue[]
    }
  | { sheet: string; error: string }
type OkSheet = Extract<SheetResult, { rows: ParsedRow[] }>

type SlotRow = {
  id: string
  program: string
  branch: string
  section: string
  semester: number
  day: string
  startTime: string
  endTime: string
  courseId: string
  room?: string | null
  faculty?: string | null
  sessionType?: string | null
}

// Same manual typing as the other admin screens (Amplify type-inference
// workaround, see AdminTimetableEditor.tsx).
const parseTimetable = (client.queries as unknown as {
  parseTimetable: (a: { key: string }) => Promise<{ data: unknown; errors?: { message: string }[] }>
}).parseTimetable
const createSlot = client.models.TimetableSlot.create as unknown as (
  input: Omit<SlotRow, 'id'>,
) => Promise<{ errors?: { message: string }[] }>
const updateSlot = client.models.TimetableSlot.update as unknown as (
  input: Partial<SlotRow> & { id: string },
) => Promise<{ errors?: { message: string }[] }>
const deleteSlot = client.models.TimetableSlot.delete as unknown as (
  input: { id: string },
) => Promise<{ errors?: { message: string }[] }>

const rowKey = (r: { day: string; courseId: string; sessionType?: string | null; section: string; startTime: string }) =>
  `${r.day}|${r.courseId}|${r.sessionType ?? ''}|${r.section}|${r.startTime}`

type Batch = { program: string; branch: string; semester: number }
type Diff = {
  added: ParsedRow[]
  changed: { existing: SlotRow; next: ParsedRow; fields: string[] }[]
  unchanged: number
  removed: SlotRow[]
}

function diffAgainst(existing: SlotRow[], rows: ParsedRow[]): Diff {
  const byKey = new Map(existing.map((r) => [rowKey(r), r]))
  const seen = new Set<string>()
  const diff: Diff = { added: [], changed: [], unchanged: 0, removed: [] }
  for (const next of rows) {
    const k = rowKey(next)
    seen.add(k)
    const cur = byKey.get(k)
    if (!cur) {
      diff.added.push(next)
      continue
    }
    const fields = (['endTime', 'room', 'faculty'] as const).filter((f) => (cur[f] ?? null) !== (next[f] ?? null))
    if (fields.length) diff.changed.push({ existing: cur, next, fields })
    else diff.unchanged++
  }
  diff.removed = existing.filter((r) => !seen.has(rowKey(r)))
  return diff
}

async function inChunks<T>(items: T[], fn: (t: T) => Promise<{ errors?: { message: string }[] }>) {
  for (let i = 0; i < items.length; i += 10) {
    const results = await Promise.all(items.slice(i, i + 10).map(fn))
    const failed = results.find((r) => r.errors?.length)
    if (failed) throw new Error(failed.errors!.map((e) => e.message).join('; '))
  }
}

export default function AdminUpload({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'parsing' | 'results' | 'applying' | 'applied'>('idle')
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState<SheetResult[]>([])
  const [selected, setSelected] = useState<OkSheet | null>(null)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [removeMissing, setRemoveMissing] = useState(false)
  const [appliedCount, setAppliedCount] = useState(0)

  const handleFile = async (file: File) => {
    setError('')
    setSelected(null)
    setDiff(null)
    setFileName(file.name)
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('Only .xlsx files are supported for now.')
      setStatus('uploading')
      const key = `timetable-uploads/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`
      await uploadData({ path: key, data: file }).result

      setStatus('parsing')
      const res = await parseTimetable({ key })
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      let payload = res.data
      while (typeof payload === 'string') payload = JSON.parse(payload)
      setSheets((payload as { sheets: SheetResult[] }).sheets)
      setStatus('results')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Upload failed.')
    }
  }

  const pickSheet = async (s: OkSheet) => {
    setSelected(s)
    setDiff(null)
    setRemoveMissing(false)
    const b = s.batch
    setBatch(b.program && b.branch && b.semester ? { program: b.program, branch: b.branch, semester: b.semester } : null)
  }

  const compare = async () => {
    if (!selected || !batch) return
    setError('')
    try {
      const { data: all } = await listAll<SlotRow>(client.models.TimetableSlot.list)
      const existing = all.filter(
        (r) => r.program === batch.program && r.branch === batch.branch && r.semester === batch.semester,
      )
      setDiff(diffAgainst(existing, selected.rows.map((r) => ({ ...r, ...batch }))))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load current timetable.')
    }
  }

  const apply = async () => {
    if (!diff || !batch) return
    setStatus('applying')
    setError('')
    try {
      await inChunks(diff.added, (r) =>
        createSlot({
          ...batch,
          day: r.day,
          startTime: r.startTime,
          endTime: r.endTime,
          courseId: r.courseId,
          sessionType: r.sessionType,
          section: r.section,
          room: r.room,
          faculty: r.faculty,
        }),
      )
      await inChunks(diff.changed, (c) =>
        updateSlot({ id: c.existing.id, endTime: c.next.endTime, room: c.next.room, faculty: c.next.faculty }),
      )
      if (removeMissing) await inChunks(diff.removed, (r) => deleteSlot({ id: r.id }))
      setAppliedCount(diff.added.length + diff.changed.length + (removeMissing ? diff.removed.length : 0))
      setStatus('applied')
    } catch (err) {
      setStatus('results')
      setError(err instanceof Error ? err.message : 'Apply failed.')
    }
  }

  if (status === 'applied') {
    return (
      <div className="dashboard">
        <h1>Timetable updated</h1>
        <p className="subtitle">
          {appliedCount} change(s) applied to {batch?.program} {batch?.branch} Sem {batch?.semester}. Review anything that
          was flagged in the Correct Timetable screen.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={onDone}>
            Open Correct Timetable
          </button>
          <button onClick={() => { setStatus('idle'); setSheets([]); setSelected(null); setDiff(null) }}>
            Upload another file
          </button>
        </div>
      </div>
    )
  }

  const flagged = selected?.issues ?? []

  return (
    <div className="dashboard">
      <h1>Upload Timetable</h1>
      <p className="subtitle">
        Upload the official timetable spreadsheet. It's stored in S3 and read by a Lambda that works out each class's
        real hours from the sheet's merged cells, checks them against the course legend's L-T-P-S, and flags anything
        it can't verify. Nothing is saved until you review and apply it.
      </p>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="file"
          accept=".xlsx"
          disabled={status === 'uploading' || status === 'parsing' || status === 'applying'}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        {status === 'uploading' && <p>Uploading {fileName} to S3...</p>}
        {status === 'parsing' && <p>Reading {fileName}...</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {sheets.length > 0 && (
        <>
          <h2>Sheets in {fileName}</h2>
          <div className="option-list">
            {sheets.map((s) =>
              'error' in s ? (
                <button key={s.sheet} disabled title={s.error}>
                  {s.sheet} — couldn't read
                </button>
              ) : (
                <button
                  key={s.sheet}
                  className={selected?.sheet === s.sheet ? 'active' : ''}
                  disabled={s.rows.length === 0}
                  title={s.rows.length === 0 ? 'No classes in a format this reader understands yet' : undefined}
                  onClick={() => pickSheet(s)}
                >
                  {s.sheet} · {s.rows.length} classes{s.issues.length ? ` · ${s.issues.length} flagged` : ''}
                </button>
              ),
            )}
          </div>
        </>
      )}

      {selected && (
        <>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2>Batch</h2>
            <p className="subtitle">Read from the sheet title: "{selected.title.split('\n').pop()}". Correct it if needed.</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <input
                placeholder="Program"
                value={batch?.program ?? ''}
                onChange={(e) => setBatch({ ...(batch ?? { branch: '', semester: 0 }), program: e.target.value })}
              />
              <input
                placeholder="Branch"
                value={batch?.branch ?? ''}
                onChange={(e) => setBatch({ ...(batch ?? { program: '', semester: 0 }), branch: e.target.value })}
              />
              <input
                type="number"
                placeholder="Semester"
                value={batch?.semester || ''}
                onChange={(e) => setBatch({ ...(batch ?? { program: '', branch: '' }), semester: Number(e.target.value) })}
              />
            </div>
          </div>

          <TimetableGrid grid={buildGrid(selected.rows.map((r) => ({ ...r }) as BusyEntry))} />

          {flagged.length > 0 && (
            <div className="card gap-warning" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h2>Flagged for review ({flagged.length})</h2>
              {flagged.map((i, n) => (
                <div key={n} className="gap-row">
                  <strong>{i.type}</strong>{' '}
                  {[i.course, i.section && `Sec ${i.section}`, i.kind].filter(Boolean).join(' · ')} {i.row}
                  {i.rows?.join(' ↔ ')} — {i.detail}
                </div>
              ))}
            </div>
          )}

          {selected.skipped.length > 0 && (
            <details className="card">
              <summary>{selected.skipped.length} line(s) not imported</summary>
              <table className="admin-table">
                <tbody>
                  {selected.skipped.map((s, n) => (
                    <tr key={n}>
                      <td>{s.day}</td>
                      <td>{s.coord}</td>
                      <td>{s.text}</td>
                      <td>{s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {!diff && (
            <button className="primary" disabled={!batch?.program || !batch.branch || !batch.semester} onClick={compare}>
              Compare with current timetable
            </button>
          )}

          {diff && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2>Changes</h2>
              <p>
                {diff.added.length} new · {diff.changed.length} changed · {diff.unchanged} unchanged ·{' '}
                {diff.removed.length} in the app but not in this file
              </p>
              {diff.changed.length > 0 && (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>Now</th>
                      <th>From file</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.changed.map((c) => (
                      <tr key={c.existing.id}>
                        <td>
                          {c.next.courseId} ({c.next.sessionType}) Sec {c.next.section} {c.next.day} {c.next.startTime}
                        </td>
                        <td>{c.fields.map((f) => `${f}: ${c.existing[f] ?? '—'}`).join(', ')}</td>
                        <td>{c.fields.map((f) => `${f}: ${c.next[f] ?? '—'}`).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {diff.removed.length > 0 && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
                  Also delete the {diff.removed.length} class(es) that aren't in this file
                </label>
              )}
              <button
                className="primary"
                disabled={status === 'applying' || diff.added.length + diff.changed.length + (removeMissing ? diff.removed.length : 0) === 0}
                onClick={apply}
              >
                {status === 'applying'
                  ? 'Applying...'
                  : `Apply ${diff.added.length + diff.changed.length + (removeMissing ? diff.removed.length : 0)} change(s)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
