import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import { listAll } from './lib/listAll'
import { runImport, type ImportResult } from './lib/importData'
import { interpretNote, matchBatch, type NoteReading } from './lib/interpretNote'

const client = generateClient<Schema>()

export type ColumnGuess = { roll: number | null; email: number | null; section: number | null; subSection: number | null }
export type TableSheet = {
  sheet: string
  kind: 'table'
  detected: 'students' | 'unknown'
  headers: string[]
  rows: string[][]
  guess: ColumnGuess
}
type SlotRow = { program: string; branch: string; semester: number }

const FIELDS: { key: keyof ColumnGuess; label: string; hint: string }[] = [
  { key: 'roll', label: 'Roll / enrollment number', hint: 'e.g. IIT2024245, 2024245 or 245' },
  { key: 'email', label: 'Institute email', hint: 'used for the roll number if there is no roll column' },
  { key: 'section', label: 'Section', hint: 'A, B, C' },
  { key: 'subSection', label: 'Sub-section', hint: 'B1, B2' },
]

export default function StudentImport({ sheet, fileKey }: { sheet: TableSheet; fileKey: string }) {
  const [mapping, setMapping] = useState<ColumnGuess>(sheet.guess)
  const [slots, setSlots] = useState<SlotRow[] | null>(null)
  const [batchKey, setBatchKey] = useState('')
  const [yearInput, setYearInput] = useState('')
  const [note, setNote] = useState('')
  const [reading, setReading] = useState<NoteReading | null>(null)
  const [secOverride, setSecOverride] = useState('')
  const [subOverride, setSubOverride] = useState('')
  const [check, setCheck] = useState<ImportResult | null>(null)
  const [removeMissing, setRemoveMissing] = useState(false)
  const [status, setStatus] = useState<'idle' | 'checking' | 'applying' | 'applied'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    setMapping(sheet.guess)
    setCheck(null)
    setStatus('idle')
    listAll<SlotRow>(client.models.TimetableSlot.list).then(({ data }) => setSlots(data))
  }, [sheet])

  const batches = useMemo(() => {
    const seen = new Map<string, SlotRow>()
    for (const s of slots ?? []) seen.set(`${s.program}|${s.branch}|${s.semester}`, s)
    return [...seen.entries()].sort((a, b) => a[1].semester - b[1].semester)
  }, [slots])
  const batch = batches.find(([k]) => k === batchKey)?.[1]

  // The note only pre-fills the fields below; the admin can still change them.
  const readNote = () => {
    const r = interpretNote(note, batches.map(([, b]) => b))
    setReading(r)
    const b = matchBatch(r, batches.map(([, b]) => b))
    if (b) setBatchKey(`${b.program}|${b.branch}|${b.semester}`)
    if (r.admissionYear) setYearInput(r.admissionYear)
    const hasGroupColumn = mapping.section !== null || mapping.subSection !== null
    if (r.subSection) setSubOverride(r.subSection)
    else if (r.section && (!hasGroupColumn || r.split)) setSecOverride(r.section)
    setCheck(null)
  }

  const run = async (dryRun: boolean) => {
    if (!batch) return
    setError('')
    setStatus(dryRun ? 'checking' : 'applying')
    try {
      const res = await runImport({
        key: fileKey,
        sheet: sheet.sheet,
        kind: 'students',
        program: batch.program,
        branch: batch.branch,
        semester: batch.semester,
        rollCol: mapping.roll,
        emailCol: mapping.email,
        sectionCol: mapping.section,
        subSectionCol: mapping.subSection,
        admissionYear: yearInput || null,
        sectionOverride: secOverride || null,
        subSectionOverride: subOverride || null,
        note: note || null,
        removeMissing,
        dryRun,
      })
      setCheck(res)
      setStatus(dryRun ? 'idle' : 'applied')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Import failed.')
    }
  }
  const reset = () => setCheck(null)

  if (status === 'applied' && check) {
    return (
      <div className="card">
        <h2>Student list saved</h2>
        <p className="subtitle">
          {check.added} added, {check.changedCount} updated{removeMissing ? `, ${check.removed} removed` : ''} for{' '}
          {batch?.program} {batch?.branch} Sem {batch?.semester}. Students see their section's classes on their next
          visit.
        </p>
      </div>
    )
  }

  const changes = check ? check.added + check.changedCount + (removeMissing ? check.removed : 0) : 0

  return (
    <>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2>Describe this file (optional)</h2>
        <textarea
          rows={2}
          placeholder='e.g. "roll numbers of section C, IT 2024 batch, sem 5" or "B1/B2 lab split for section B, sem 5"'
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" disabled={!note.trim() || !slots} onClick={readNote}>
            Use this note
          </button>
          {reading && (
            <span className="meta">
              {reading.understood.length
                ? `Understood: ${reading.understood.join(' · ')}. Check the fields below.`
                : "Couldn't pick anything out of that. Fill in the fields below."}
            </span>
          )}
        </div>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2>{sheet.detected === 'students' ? 'Student list' : "Couldn't tell what this sheet is"}</h2>
        <p className="subtitle">
          {sheet.detected === 'students'
            ? 'Columns were matched from their headers and values. Check them before continuing. No section column? Say which section in the note or the fields below.'
            : 'Pick which column holds what. Needs a roll number or email.'}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <select
                value={mapping[f.key] ?? ''}
                onChange={(e) => {
                  reset()
                  setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })
                }}
              >
                <option value="">— none —</option>
                {sheet.headers.map((h, c) => (
                  <option key={c} value={c}>
                    {h || `Column ${c + 1}`}
                  </option>
                ))}
              </select>
              <span className="meta">{f.hint}</span>
            </label>
          ))}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                {sheet.headers.map((h, c) => {
                  const role = FIELDS.find((f) => mapping[f.key] === c)
                  return (
                    <th key={c}>
                      {h || `Column ${c + 1}`}
                      {role && <div className="meta">→ {role.label}</div>}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.slice(0, 5).map((row, i) => (
                <tr key={i}>
                  {sheet.headers.map((_, c) => (
                    <td key={c}>{row[c]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta">{sheet.rows.length} rows in total.</p>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2>Which batch is this list for?</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select
            value={batchKey}
            onChange={(e) => {
              setBatchKey(e.target.value)
              reset()
            }}
          >
            <option value="">Pick a batch</option>
            {batches.map(([k, b]) => (
              <option key={k} value={k}>
                {b.program} {b.branch} — Semester {b.semester}
              </option>
            ))}
          </select>
          <input
            placeholder="Admission year (only if rolls don't include it)"
            value={yearInput}
            onChange={(e) => {
              setYearInput(e.target.value.trim())
              reset()
            }}
            style={{ minWidth: 300 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>Same for every row (if the file doesn't say):</span>
          <input
            placeholder="Section, e.g. C"
            value={secOverride}
            onChange={(e) => {
              setSecOverride(e.target.value.trim().toUpperCase())
              reset()
            }}
            style={{ width: 130 }}
          />
          <input
            placeholder="Sub-section, e.g. B1"
            value={subOverride}
            onChange={(e) => {
              setSubOverride(e.target.value.trim().toUpperCase())
              reset()
            }}
            style={{ width: 160 }}
          />
        </div>
        {!check && (
          <button className="primary" disabled={!batch || status === 'checking'} onClick={() => run(true)}>
            {status === 'checking' ? 'Checking...' : 'Check and compare'}
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      {check && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2>Check</h2>
          <p>
            {check.valid} students ready
            {check.counts &&
              Object.keys(check.counts).length > 0 &&
              ` (${Object.entries(check.counts)
                .sort()
                .map(([k, n]) => `${k}: ${n}`)
                .join(', ')})`}
            {check.problemCount ? ` · ${check.problemCount} row(s) won't be imported` : ''}
          </p>
          {check.problems.length > 0 && (
            <div className="gap-warning card" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {check.problems.map((p) => (
                <div key={p.line} className="gap-row">
                  Row {p.line}: {p.problems.join('; ')}
                </div>
              ))}
            </div>
          )}
          <p>
            {check.added} new · {check.changedCount} changed · {check.unchanged} unchanged · {check.removed} saved for
            this batch but not in this file
          </p>
          {check.changed.length > 0 && (
            <table className="admin-table">
              <tbody>
                {check.changed.map((c) => (
                  <tr key={c.what}>
                    <td>{c.what}</td>
                    <td>
                      {c.before} → {c.after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {check.removed > 0 && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
              Also delete the {check.removed} student(s) that aren't in this file
            </label>
          )}
          <button className="primary" disabled={status === 'applying' || changes === 0} onClick={() => run(false)}>
            {status === 'applying' ? 'Saving...' : `Apply ${changes} change(s)`}
          </button>
        </div>
      )}
    </>
  )
}
