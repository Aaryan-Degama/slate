import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import { listAll } from './lib/listAll'
import { runImport, type ImportResult } from './lib/importData'

const client = generateClient<Schema>()

export type ColumnGuess = { roll: number | null; email: number | null; name: number | null; section: number | null; subSection: number | null }
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
  { key: 'name', label: 'Name', hint: 'shown in the admin student list' },
  { key: 'section', label: 'Section', hint: 'A, B, C' },
  { key: 'subSection', label: 'Sub-section', hint: 'B1, B2' },
]

export default function StudentImport({ sheet, fileKey }: { sheet: TableSheet; fileKey: string }) {
  const [mapping, setMapping] = useState<ColumnGuess>(sheet.guess)
  const [slots, setSlots] = useState<SlotRow[] | null>(null)
  const [semester, setSemester] = useState('')
  /** Roll prefix -> batch key it belongs to ('' = skip it). */
  const [assign, setAssign] = useState<Record<string, string>>({})
  const [yearInput, setYearInput] = useState('')
  const [secOverride, setSecOverride] = useState('')
  const [subOverride, setSubOverride] = useState('')
  const [check, setCheck] = useState<{ batch: SlotRow; prefixes: string[]; res: ImportResult }[] | null>(null)
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
  // Odd semesters run this term; a batch with no timetable ingested yet
  // (e.g. 7th) can still have its students loaded.
  const semesters = [...new Set([...batches.map(([, b]) => b.semester), 1, 3, 5, 7])].sort((a, b) => a - b)
  const countByPrefix = useMemo(() => {
    const col = mapping.roll ?? mapping.email
    const out: Record<string, number> = {}
    if (col === null) return out
    for (const row of sheet.rows) {
      const m = (row[col] ?? '').trim().match(/^([A-Za-z]{3,4})\d{4}\d+/)
      if (m) out[m[1].toUpperCase()] = (out[m[1].toUpperCase()] ?? 0) + 1
    }
    return out
  }, [sheet, mapping])
  const inSemester = useMemo(() => {
    const n = Number(semester)
    const real = batches.filter(([, b]) => b.semester === n)
    // Offer every branch we know of, even where this semester's timetable
    // hasn't been ingested: the students can go in first.
    const branches = [...new Set(batches.map(([, b]) => `${b.program}|${b.branch}`))]
    const extra = branches
      .filter((k) => !real.some(([, b]) => `${b.program}|${b.branch}` === k))
      .map((k) => {
        const [program, branch] = k.split('|')
        return [`${program}|${branch}|${n}`, { program, branch, semester: n }] as [string, SlotRow]
      })
    return [...real, ...extra].sort((a, b) => a[1].branch.localeCompare(b[1].branch))
  }, [batches, semester])
  const hasTimetable = (b: SlotRow) => batches.some(([, x]) => x.program === b.program && x.branch === b.branch && x.semester === b.semester)

  // One sheet can list a whole admission year across programmes (IIT, IIB,
  // IEC, BD...). Default to the ones whose letters match the batch's branch
  // (IIT for IT); the admin ticks any others that sit in this batch.
  const sheetPrefixes = useMemo(() => {
    const col = mapping.roll ?? mapping.email
    if (col === null) return []
    const out = new Set<string>()
    for (const row of sheet.rows) {
      const m = (row[col] ?? '').trim().match(/^([A-Za-z]{3,4})\d{4}\d+/)
      if (m) out.add(m[1].toUpperCase())
    }
    return [...out].sort()
  }, [sheet, mapping])
  // Default each programme to the batch whose branch its letters match
  // (IIT -> IT, IEC -> EC). Others (IIB, BD...) are left for the admin,
  // since only they know which batch those students sit with.
  useEffect(() => {
    if (!semester) return
    setAssign(
      Object.fromEntries(
        sheetPrefixes.map((p) => [p, inSemester.find(([, b]) => b.branch.toUpperCase() === p.slice(1))?.[0] ?? '']),
      ),
    )
    setCheck(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetPrefixes, semester])

  /** One import per batch, with the prefixes assigned to it. */
  const groups = useMemo(() => {
    const byBatch = new Map<string, string[]>()
    for (const [prefix, key] of Object.entries(assign)) if (key) byBatch.set(key, [...(byBatch.get(key) ?? []), prefix])
    return [...byBatch.entries()].map(([key, prefixes]) => {
      const [program, branch, sem] = key.split('|')
      const batch = batches.find(([k]) => k === key)?.[1] ?? { program, branch, semester: Number(sem) }
      return { batch, prefixes }
    })
  }, [assign, batches])

  const run = async (dryRun: boolean) => {
    if (!groups.length) return
    setError('')
    setStatus(dryRun ? 'checking' : 'applying')
    try {
      const out = []
      for (const g of groups) {
        const res = await runImport({
          key: fileKey,
          sheet: sheet.sheet,
          kind: 'students',
          program: g.batch.program,
          branch: g.batch.branch,
          semester: g.batch.semester,
          rollCol: mapping.roll,
          emailCol: mapping.email,
          nameCol: mapping.name,
          sectionCol: mapping.section,
          subSectionCol: mapping.subSection,
          onlyPrefixes: g.prefixes,
          admissionYear: yearInput || null,
          sectionOverride: secOverride || null,
          subSectionOverride: subOverride || null,
          removeMissing,
          dryRun,
        })
        out.push({ batch: g.batch, prefixes: g.prefixes, res })
      }
      setCheck(out)
      setStatus(dryRun ? 'idle' : 'applied')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Import failed.')
    }
  }

  const total = (pick: (r: ImportResult) => number) => (check ?? []).reduce((n, c) => n + pick(c.res), 0)

  const reset = () => setCheck(null)

  if (status === 'applied' && check) {
    return (
      <div className="card">
        <h2>Student list saved</h2>
        <p className="subtitle">
          {total((r) => r.added)} added, {total((r) => r.changedCount)} updated
          {removeMissing ? `, ${total((r) => r.removed)} removed` : ''} across {check.length} batch(es). Students see
          their section's classes on their next visit.
        </p>
        <ul className="change-history">
          {check.map((c) => (
            <li key={`${c.batch.branch}${c.batch.semester}`}>
              <span>
                {c.batch.program} {c.batch.branch} Sem {c.batch.semester} · {c.prefixes.join(', ')}
              </span>
              <span className="meta">
                {c.res.added} added · {c.res.changedCount} updated
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const changes = total((r) => r.added + r.changedCount + (removeMissing ? r.removed : 0))

  return (
    <>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2>{sheet.detected === 'students' ? 'Student list' : "Couldn't tell what this sheet is"}</h2>
        <p className="subtitle">
          {sheet.detected === 'students'
            ? 'Columns were matched from their headers and values. Check them before continuing. No section column? Fill in the section below.'
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
        <div className="table-scroll">
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
              {sheet.rows.map((row, i) => (
                <tr key={i}>
                  {sheet.headers.map((_, c) => (
                    <td key={c}>{row[c]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta">{sheet.rows.length} rows in total — scroll the table to check them.</p>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2>Which batch is this list for?</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select
            value={semester}
            onChange={(e) => {
              setSemester(e.target.value)
              setCheck(null)
            }}
          >
            <option value="">Pick a semester</option>
            {semesters.map((n) => (
              <option key={n} value={String(n)}>
                Semester {n}
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

        {semester && sheetPrefixes.length > 0 && (
          <>
            <p>
              This file lists {sheetPrefixes.length} programme(s). Which batch does each sit with? Roll numbers restart
              per programme, so they're kept apart.
            </p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Programme</th>
                  <th>Students in file</th>
                  <th>Goes to</th>
                </tr>
              </thead>
              <tbody>
                {sheetPrefixes.map((p) => (
                  <tr key={p}>
                    <td>
                      <strong>{p}</strong>
                    </td>
                    <td className="meta">{countByPrefix[p] ?? 0}</td>
                    <td>
                      <select
                        value={assign[p] ?? ''}
                        onChange={(e) => {
                          setAssign({ ...assign, [p]: e.target.value })
                          setCheck(null)
                        }}
                      >
                        <option value="">— skip —</option>
                        {inSemester.map(([k, b]) => (
                          <option key={k} value={k}>
                            {b.program} {b.branch} Sem {b.semester}
                            {hasTimetable(b) ? '' : ' (no timetable yet)'}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

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
          <button className="primary" disabled={!groups.length || status === 'checking'} onClick={() => run(true)}>
            {status === 'checking' ? 'Checking...' : 'Check and compare'}
          </button>
        )}
      {error && <p className="error">{error}</p>}
      </div>

      {check && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2>Check</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Programmes</th>
                <th>Ready</th>
                <th>New</th>
                <th>Changed</th>
                <th>Unchanged</th>
                <th>Not in file</th>
              </tr>
            </thead>
            <tbody>
              {check.map(({ batch, prefixes, res }) => (
                <tr key={`${batch.branch}${batch.semester}`}>
                  <td>
                    {batch.program} {batch.branch} Sem {batch.semester}
                  </td>
                  <td>{prefixes.join(', ')}</td>
                  <td>{res.valid ?? 0}</td>
                  <td>{res.added}</td>
                  <td>{res.changedCount}</td>
                  <td>{res.unchanged}</td>
                  <td>{res.removed}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {check.some((c) => c.res.problemCount) && (
            <div className="gap-warning card" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {check.flatMap(({ batch, res }) =>
                res.problems.map((p) => (
                  <div key={`${batch.branch}${batch.semester}-${p.line}`} className="gap-row">
                    {batch.branch} Sem {batch.semester} · row {p.line}: {p.problems.join('; ')}
                  </div>
                )),
              )}
              <div className="meta">
                {total((r) => r.problemCount ?? 0)} row(s) won't be imported. Everything else still goes in.
              </div>
            </div>
          )}

          {total((r) => r.removed) > 0 && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
              Also delete the {total((r) => r.removed)} student(s) saved for these batches but not in this file
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
