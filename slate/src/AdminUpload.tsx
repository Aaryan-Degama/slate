import { useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import { uploadData } from 'aws-amplify/storage'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, type BusyEntry } from './lib/grid'
import { runImport, type ImportResult } from './lib/importData'
import StudentImport, { type TableSheet } from './StudentImport'

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
      kind: 'timetable'
      title: string
      batch: { program: string | null; branch: string | null; semester: number | null }
      rows: ParsedRow[]
      skipped: { coord: string; day: string; text: string; reason: string }[]
      issues: Issue[]
    }
  | TableSheet
  | { sheet: string; kind: 'error'; error: string }
type OkSheet = Extract<SheetResult, { kind: 'timetable' }>

// Same manual typing as the other admin screens (Amplify type-inference
// workaround, see AdminTimetableEditor.tsx).
const parseTimetable = (client.queries as unknown as {
  parseTimetable: (a: { key: string }) => Promise<{ data: unknown; errors?: { message: string }[] }>
}).parseTimetable

type Batch = { program: string; branch: string; semester: number }

export default function AdminUpload({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'parsing' | 'results' | 'applying' | 'applied'>('idle')
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState<SheetResult[]>([])
  const [selected, setSelected] = useState<OkSheet | null>(null)
  const [selectedTable, setSelectedTable] = useState<TableSheet | null>(null)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [diff, setDiff] = useState<ImportResult | null>(null)
  const [fileKey, setFileKey] = useState('')
  const [removeMissing, setRemoveMissing] = useState(false)
  const [appliedCount, setAppliedCount] = useState(0)

  const handleFile = async (file: File) => {
    setError('')
    setSelected(null)
    setSelectedTable(null)
    setDiff(null)
    setFileName(file.name)
    try {
      if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error('Upload an .xlsx or .csv file.')
      setStatus('uploading')
      const key = `timetable-uploads/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`
      await uploadData({ path: key, data: file }).result
      setFileKey(key)

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
    setSelectedTable(null)
    setSelected(s)
    setDiff(null)
    setRemoveMissing(false)
    const b = s.batch
    setBatch(b.program && b.branch && b.semester ? { program: b.program, branch: b.branch, semester: b.semester } : null)
  }

  const runTimetable = async (dryRun: boolean) => {
    if (!selected || !batch) return
    setError('')
    if (!dryRun) setStatus('applying')
    try {
      const res = await runImport({ key: fileKey, sheet: selected.sheet, kind: 'timetable', ...batch, removeMissing, dryRun })
      setDiff(res)
      if (!dryRun) {
        setAppliedCount(res.added + res.changedCount + (removeMissing ? res.removed : 0))
        setStatus('applied')
      }
    } catch (err) {
      if (!dryRun) setStatus('results')
      setError(err instanceof Error ? err.message : 'Import failed.')
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
      <h1>Upload Data</h1>
      <p className="subtitle">
        Upload a timetable spreadsheet or a student list (sections, or a B1/B2 split). The file is stored in S3 and a
        Lambda works out what each sheet is: timetables are checked against the course legend's L-T-P-S, and student
        lists get their columns matched for you to confirm. Nothing is saved until you review and apply it.
      </p>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="file"
          accept=".xlsx,.csv"
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
              s.kind === 'error' ? (
                <button key={s.sheet} disabled title={s.error}>
                  {s.sheet} — couldn't read
                </button>
              ) : s.kind === 'table' ? (
                <button
                  key={s.sheet}
                  className={selectedTable?.sheet === s.sheet ? 'active' : ''}
                  disabled={s.rows.length === 0}
                  onClick={() => {
                    setSelected(null)
                    setSelectedTable(s)
                  }}
                >
                  {s.sheet} · {s.detected === 'students' ? 'student list' : 'unrecognised table'} · {s.rows.length} rows
                </button>
              ) : (
                <button
                  key={s.sheet}
                  className={selected?.sheet === s.sheet ? 'active' : ''}
                  disabled={s.rows.length === 0}
                  title={s.rows.length === 0 ? 'No classes in a format this reader understands yet' : undefined}
                  onClick={() => pickSheet(s)}
                >
                  {s.sheet} · timetable · {s.rows.length} classes{s.issues.length ? ` · ${s.issues.length} flagged` : ''}
                </button>
              ),
            )}
          </div>
        </>
      )}

      {selectedTable && <StudentImport sheet={selectedTable} fileKey={fileKey} />}

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
            <button
              className="primary"
              disabled={!batch?.program || !batch.branch || !batch.semester}
              onClick={() => runTimetable(true)}
            >
              Compare with current timetable
            </button>
          )}
          {error && <p className="error">{error}</p>}

          {diff && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2>Changes</h2>
              <p>
                {diff.added} new · {diff.changedCount} changed · {diff.unchanged} unchanged · {diff.removed} in the app
                but not in this file
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
                      <tr key={c.what}>
                        <td>{c.what}</td>
                        <td>{c.before}</td>
                        <td>{c.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {diff.removed > 0 && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
                  Also delete the {diff.removed} class(es) that aren't in this file
                </label>
              )}
              <button
                className="primary"
                disabled={status === 'applying' || diff.added + diff.changedCount + (removeMissing ? diff.removed : 0) === 0}
                onClick={() => runTimetable(false)}
              >
                {status === 'applying'
                  ? 'Applying...'
                  : `Apply ${diff.added + diff.changedCount + (removeMissing ? diff.removed : 0)} change(s)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
