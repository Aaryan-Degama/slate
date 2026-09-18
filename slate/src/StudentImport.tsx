import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import { listAll } from './lib/listAll'

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

type SlotRow = { program: string; branch: string; semester: number; section: string }
type StudentRow = {
  id: string
  admissionYear: string
  rollNumber: number
  program: string
  branch: string
  semester: number
  section: string
  subSection?: string | null
}
type Batch = { program: string; branch: string; semester: number }
type Rec = { line: number; year?: string; roll?: number; section?: string; subSection?: string; problems: string[] }

const createStudent = client.models.StudentSection.create as unknown as (
  input: Omit<StudentRow, 'id'>,
) => Promise<{ errors?: { message: string }[] }>
const updateStudent = client.models.StudentSection.update as unknown as (
  input: Partial<StudentRow> & { id: string },
) => Promise<{ errors?: { message: string }[] }>
const deleteStudent = client.models.StudentSection.delete as unknown as (
  input: { id: string },
) => Promise<{ errors?: { message: string }[] }>

const FIELDS: { key: keyof ColumnGuess; label: string; hint: string }[] = [
  { key: 'roll', label: 'Roll / enrollment number', hint: 'e.g. IIT2024245, 2024245 or 245' },
  { key: 'email', label: 'Institute email', hint: 'used for the roll number if there is no roll column' },
  { key: 'section', label: 'Section', hint: 'A, B, C' },
  { key: 'subSection', label: 'Sub-section', hint: 'B1, B2' },
]

/** IIT2024245 / 2024245 / iit2024245@iiita.ac.in -> year + roll; 245 -> roll only. */
function parseId(value: string): { year?: string; roll?: number } {
  const v = value.trim()
  let m = /^(?:[A-Za-z]{2,4})?(\d{4})(\d{3})$/.exec(v)
  if (m) return { year: m[1], roll: Number(m[2]) }
  m = /^[A-Za-z]{2,4}(\d{4})(\d+)@/.exec(v)
  if (m) return { year: m[1], roll: Number(m[2]) }
  if (/^\d{1,3}$/.test(v)) return { roll: Number(v) }
  return {}
}

async function inChunks<T>(items: T[], fn: (t: T) => Promise<{ errors?: { message: string }[] }>) {
  for (let i = 0; i < items.length; i += 10) {
    const results = await Promise.all(items.slice(i, i + 10).map(fn))
    const failed = results.find((r) => r.errors?.length)
    if (failed) throw new Error(failed.errors!.map((e) => e.message).join('; '))
  }
}

export default function StudentImport({ sheet }: { sheet: TableSheet }) {
  const [mapping, setMapping] = useState<ColumnGuess>(sheet.guess)
  const [slots, setSlots] = useState<SlotRow[] | null>(null)
  const [batchKey, setBatchKey] = useState('')
  const [yearInput, setYearInput] = useState('')
  const [diff, setDiff] = useState<{
    added: Rec[]
    changed: { existing: StudentRow; next: Rec }[]
    unchanged: number
    removed: StudentRow[]
  } | null>(null)
  const [removeMissing, setRemoveMissing] = useState(false)
  const [status, setStatus] = useState<'idle' | 'applying' | 'applied'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    setMapping(sheet.guess)
    setDiff(null)
    setStatus('idle')
    listAll<SlotRow>(client.models.TimetableSlot.list).then(({ data }) => setSlots(data))
  }, [sheet])

  const batches = useMemo(() => {
    const seen = new Map<string, Batch>()
    for (const s of slots ?? []) seen.set(`${s.program}|${s.branch}|${s.semester}`, s)
    return [...seen.entries()].sort((a, b) => a[1].semester - b[1].semester)
  }, [slots])
  const batch = batches.find(([k]) => k === batchKey)?.[1]

  const records = useMemo<Rec[]>(() => {
    if (!batch) return []
    const inBatch = (slots ?? []).filter(
      (s) => s.program === batch.program && s.branch === batch.branch && s.semester === batch.semester,
    )
    const letters = new Set(inBatch.map((s) => s.section[0]))
    const subs = new Set(inBatch.map((s) => s.section).filter((s) => s.length === 2))
    const cell = (row: string[], c: number | null) => (c === null ? '' : (row[c] ?? '').trim())

    const recs = sheet.rows.map((row, i): Rec => {
      const fromRoll = parseId(cell(row, mapping.roll))
      const id = fromRoll.roll !== undefined ? fromRoll : parseId(cell(row, mapping.email))
      const sub = cell(row, mapping.subSection).toUpperCase() || undefined
      const section = cell(row, mapping.section).toUpperCase() || sub?.[0]
      const problems: string[] = []
      if (id.roll === undefined) problems.push('no readable roll number')
      const year = id.year ?? (yearInput || undefined)
      if (!year) problems.push('no admission year (enter it above)')
      if (!section) problems.push('no section')
      else if (!letters.has(section)) problems.push(`section ${section} isn't in this batch's timetable`)
      if (sub) {
        if (!subs.has(sub)) problems.push(`sub-section ${sub} isn't in this batch's timetable`)
        if (section && sub[0] !== section) problems.push(`sub-section ${sub} doesn't belong to section ${section}`)
      }
      return { line: i + 1, year, roll: id.roll, section, subSection: sub, problems }
    })

    const byStudent = new Map<string, Rec[]>()
    for (const r of recs) {
      if (r.roll === undefined || !r.year) continue
      const k = `${r.year}|${r.roll}`
      byStudent.set(k, [...(byStudent.get(k) ?? []), r])
    }
    for (const group of byStudent.values()) {
      if (new Set(group.map((r) => `${r.section}|${r.subSection}`)).size > 1)
        group.forEach((r) => r.problems.push('same student listed with different sections'))
    }
    return recs
  }, [sheet, mapping, batch, slots, yearInput])

  const valid = records.filter((r) => r.problems.length === 0)
  const bad = records.filter((r) => r.problems.length > 0)
  const counts = new Map<string, number>()
  for (const r of valid) {
    const k = r.subSection ?? r.section!
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const unique = [...new Map(valid.map((r) => [`${r.year}|${r.roll}`, r])).values()]

  const compare = async () => {
    if (!batch) return
    setError('')
    try {
      const { data } = await listAll<StudentRow>(client.models.StudentSection.list)
      const existing = data.filter(
        (s) => s.program === batch.program && s.branch === batch.branch && s.semester === batch.semester,
      )
      const byKey = new Map(existing.map((s) => [`${s.admissionYear}|${s.rollNumber}`, s]))
      const next = { added: [] as Rec[], changed: [] as { existing: StudentRow; next: Rec }[], unchanged: 0, removed: [] as StudentRow[] }
      for (const r of unique) {
        const cur = byKey.get(`${r.year}|${r.roll}`)
        if (!cur) next.added.push(r)
        else if (cur.section !== r.section || (mapping.subSection !== null && (cur.subSection ?? undefined) !== r.subSection))
          next.changed.push({ existing: cur, next: r })
        else next.unchanged++
      }
      const seen = new Set(unique.map((r) => `${r.year}|${r.roll}`))
      next.removed = existing.filter((s) => !seen.has(`${s.admissionYear}|${s.rollNumber}`))
      setDiff(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load current student list.')
    }
  }

  const apply = async () => {
    if (!diff || !batch) return
    setStatus('applying')
    setError('')
    try {
      await inChunks(diff.added, (r) =>
        createStudent({
          ...batch,
          admissionYear: r.year!,
          rollNumber: r.roll!,
          section: r.section!,
          subSection: r.subSection ?? null,
        }),
      )
      await inChunks(diff.changed, (c) =>
        updateStudent({
          id: c.existing.id,
          section: c.next.section!,
          ...(mapping.subSection !== null ? { subSection: c.next.subSection ?? null } : {}),
        }),
      )
      if (removeMissing) await inChunks(diff.removed, (s) => deleteStudent({ id: s.id }))
      setStatus('applied')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Apply failed.')
    }
  }

  if (status === 'applied' && diff) {
    return (
      <div className="card">
        <h2>Student list saved</h2>
        <p className="subtitle">
          {diff.added.length} added, {diff.changed.length} updated
          {removeMissing ? `, ${diff.removed.length} removed` : ''} for {batch?.program} {batch?.branch} Sem{' '}
          {batch?.semester}. Students see their section's classes on their next visit.
        </p>
      </div>
    )
  }

  const changes = diff ? diff.added.length + diff.changed.length + (removeMissing ? diff.removed.length : 0) : 0

  return (
    <>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2>{sheet.detected === 'students' ? 'Student list' : "Couldn't tell what this sheet is"}</h2>
        <p className="subtitle">
          {sheet.detected === 'students'
            ? 'Columns were matched from their headers and values. Check them before continuing.'
            : 'Pick which column holds what. Needs a roll number or email, and a section or sub-section.'}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <select
                value={mapping[f.key] ?? ''}
                onChange={(e) => {
                  setDiff(null)
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
              setDiff(null)
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
              setDiff(null)
            }}
            style={{ minWidth: 300 }}
          />
        </div>
      </div>

      {batch && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2>Check</h2>
          <p>
            {unique.length} students ready
            {counts.size > 0 &&
              ` (${[...counts.entries()]
                .sort()
                .map(([k, n]) => `${k}: ${n}`)
                .join(', ')})`}
            {bad.length > 0 && ` · ${bad.length} row(s) won't be imported`}
          </p>
          {bad.length > 0 && (
            <div className="gap-warning card" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {bad.slice(0, 100).map((r) => (
                <div key={r.line} className="gap-row">
                  Row {r.line}: {r.problems.join('; ')}
                </div>
              ))}
            </div>
          )}
          {!diff && (
            <button className="primary" disabled={unique.length === 0} onClick={compare}>
              Compare with current student list
            </button>
          )}
          {diff && (
            <>
              <p>
                {diff.added.length} new · {diff.changed.length} changed · {diff.unchanged} unchanged ·{' '}
                {diff.removed.length} saved for this batch but not in this file
              </p>
              {diff.changed.length > 0 && (
                <table className="admin-table">
                  <tbody>
                    {diff.changed.slice(0, 50).map((c) => (
                      <tr key={c.existing.id}>
                        <td>
                          {c.existing.admissionYear} / {c.existing.rollNumber}
                        </td>
                        <td>
                          {c.existing.subSection ?? c.existing.section} → {c.next.subSection ?? c.next.section}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {diff.removed.length > 0 && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
                  Also delete the {diff.removed.length} student(s) that aren't in this file
                </label>
              )}
              <button className="primary" disabled={status === 'applying' || changes === 0} onClick={apply}>
                {status === 'applying' ? 'Saving...' : `Apply ${changes} change(s)`}
              </button>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </>
  )
}
