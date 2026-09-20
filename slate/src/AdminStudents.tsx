import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import { listAll } from './lib/listAll'
import StudentTable, { buildStudentRows } from './components/StudentTable'

const client = generateClient<Schema>()

type StudentRow = {
  admissionYear: string
  rollNumber: number
  rollPrefix?: string | null
  name?: string | null
  program: string
  branch: string
  semester: number
  section: string
  subSection?: string | null
  updatedAt?: string
}
type RangeRow = {
  id: string
  admissionYear: string
  program: string
  branch: string
  semester: number
  minRoll: number
  maxRoll: number
  section: string
}
type SlotRow = { program: string; branch: string; semester: number; section: string }
type Batch = { program: string; branch: string; semester: number }
type Draft = { id?: string; admissionYear: string; section: string; minRoll: string; maxRoll: string }

type Res = Promise<{ errors?: { message: string }[] }>
const createRange = client.models.RollRange.create as unknown as (i: Omit<RangeRow, 'id'>) => Res
const updateRange = client.models.RollRange.update as unknown as (i: Partial<RangeRow> & { id: string }) => Res
const deleteRange = client.models.RollRange.delete as unknown as (i: { id: string }) => Res

const isSub = (s: string) => /^[A-Z]\d$/.test(s)
const batchKey = (b: Batch) => `${b.program}|${b.branch}|${b.semester}`

/** Problems with a batch's ranges: overlaps, sub-sections outside their section, gaps. */
function checkRanges(ranges: RangeRow[]): string[] {
  const out: string[] = []
  const byYear = new Map<string, RangeRow[]>()
  for (const r of ranges) byYear.set(r.admissionYear, [...(byYear.get(r.admissionYear) ?? []), r])
  for (const [year, rs] of byYear) {
    for (const level of [false, true]) {
      const list = rs.filter((r) => isSub(r.section) === level).sort((a, b) => a.minRoll - b.minRoll)
      for (let i = 1; i < list.length; i++) {
        const [a, b] = [list[i - 1], list[i]]
        if (b.minRoll <= a.maxRoll) out.push(`${year}: ${a.section} (${a.minRoll}–${a.maxRoll}) and ${b.section} (${b.minRoll}–${b.maxRoll}) overlap`)
        else if (!level && b.minRoll > a.maxRoll + 1) out.push(`${year}: rolls ${a.maxRoll + 1}–${b.minRoll - 1} aren't in any section`)
      }
    }
    for (const parent of rs.filter((r) => !isSub(r.section))) {
      const subs = rs.filter((r) => isSub(r.section) && r.section[0] === parent.section).sort((a, b) => a.minRoll - b.minRoll)
      if (!subs.length) continue
      for (const s of subs)
        if (s.minRoll < parent.minRoll || s.maxRoll > parent.maxRoll)
          out.push(`${year}: ${s.section} (${s.minRoll}–${s.maxRoll}) goes outside section ${parent.section} (${parent.minRoll}–${parent.maxRoll})`)
      let next = parent.minRoll
      for (const s of subs) {
        if (s.minRoll > next) out.push(`${year}: rolls ${next}–${s.minRoll - 1} of section ${parent.section} aren't in any sub-section`)
        next = Math.max(next, s.maxRoll + 1)
      }
      if (next <= parent.maxRoll) out.push(`${year}: rolls ${next}–${parent.maxRoll} of section ${parent.section} aren't in any sub-section`)
    }
  }
  return out
}

/** Section-wise student lists and roll ranges per batch. */
export default function AdminStudents() {
  const [students, setStudents] = useState<StudentRow[] | null>(null)
  const [ranges, setRanges] = useState<RangeRow[]>([])
  const [slots, setSlots] = useState<SlotRow[]>([])
  const [key, setKey] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showRanges, setShowRanges] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = () => {
    listAll<StudentRow>(client.models.StudentSection.list).then(({ data }) => setStudents(data))
    listAll<RangeRow>(client.models.RollRange.list).then(({ data }) => setRanges(data))
  }
  useEffect(() => {
    reload()
    listAll<SlotRow>(client.models.TimetableSlot.list).then(({ data }) => setSlots(data))
  }, [])

  const batches = useMemo(() => {
    const m = new Map<string, Batch>()
    for (const r of [...slots, ...(students ?? []), ...ranges]) m.set(batchKey(r), r)
    return [...m.entries()].sort((a, b) => a[1].branch.localeCompare(b[1].branch) || a[1].semester - b[1].semester)
  }, [slots, students, ranges])

  useEffect(() => {
    if (!key && batches.length) setKey(batches[0][0])
  }, [batches, key])

  if (!students) return <p>Loading...</p>

  const batch = batches.find(([k]) => k === key)?.[1]
  const inBatch = (r: Batch) => batchKey(r) === key
  const mine = students.filter(inBatch)
  const myRanges = ranges.filter(inBatch).sort((a, b) => a.admissionYear.localeCompare(b.admissionYear) || a.minRoll - b.minRoll)
  const sectionsInTimetable = [...new Set(slots.filter(inBatch).map((s) => s.section))].sort()
  const split = sectionsInTimetable.filter(isSub)
  const lastUpdate = mine.map((s) => s.updatedAt ?? '').sort().at(-1)
  const problems = checkRanges(myRanges)
  const missingSplit = [...new Set(split.map((s) => s[0]))].filter(
    (p) => !myRanges.some((r) => r.section.startsWith(p) && isSub(r.section)) && !mine.some((s) => s.section === p && s.subSection),
  )

  const save = async () => {
    if (!draft || !batch) return
    setError('')
    const min = Number(draft.minRoll)
    const max = Number(draft.maxRoll)
    const section = draft.section.trim().toUpperCase()
    if (!/^\d{4}$/.test(draft.admissionYear)) return setError('Admission year should look like 2024.')
    if (!/^[A-Z]\d?$/.test(section)) return setError('Section should look like A or B1.')
    if (sectionsInTimetable.length && !sectionsInTimetable.includes(section))
      return setError(`Section ${section} isn't in this batch's timetable (${sectionsInTimetable.join(', ')}).`)
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return setError('Rolls should be whole numbers, from ≤ to.')
    const next = { ...batch, admissionYear: draft.admissionYear, section, minRoll: min, maxRoll: max }
    const clash = checkRanges([...myRanges.filter((r) => r.id !== draft.id), { ...next, id: 'draft' }]).filter(
      (p) => p.includes('overlap') || p.includes('goes outside'),
    )
    if (clash.length) return setError(clash.join('; '))
    setSaving(true)
    try {
      const res = draft.id ? await updateRange({ id: draft.id, ...next }) : await createRange(next)
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      setDraft(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (r: RangeRow) => {
    setError('')
    const res = await deleteRange({ id: r.id })
    if (res.errors?.length) setError(res.errors.map((e) => e.message).join('; '))
    reload()
  }

  return (
    <div className="dashboard">
      <h1>Students</h1>
      <p className="subtitle">
        Who is in which section: roll ranges (e.g. "B1 = rolls 108–160") and uploaded student lists. A student in an
        uploaded list uses that; everyone else is matched by roll range.
      </p>

      <div className="option-list">
        {batches.map(([k, b]) => (
          <button
            key={k}
            className={k === key ? 'active' : ''}
            onClick={() => {
              setKey(k)
              setDraft(null)
              setError('')
              setShowRanges(false)
            }}
          >
            {b.program} {b.branch} — Semester {b.semester}
          </button>
        ))}
      </div>

      {batch && mine.length > 0 && !showRanges && (
        <p className="meta">
          {mine.length} students uploaded for this batch, so roll ranges aren't needed.{' '}
          <button type="button" className="link" onClick={() => setShowRanges(true)}>
            Show roll ranges{myRanges.length ? ` (${myRanges.length})` : ''}
          </button>
        </p>
      )}

      {batch && (
        <>
          {(mine.length === 0 || showRanges) && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2>Roll ranges</h2>
            <p className="subtitle">
              A fallback for batches with no uploaded list: "Sec A = rolls 1–107" places a student whose roll isn't
              listed. An uploaded list always wins.
            </p>
            <p className="subtitle">
              Sections in this batch's timetable: {sectionsInTimetable.join(', ') || 'none'}.{' '}
              {split.length > 0 && 'For a split like B1/B2, add a range for each sub-section inside B.'}
            </p>
            {missingSplit.length > 0 && (
              <p className="gap-warning card" style={{ padding: 12 }}>
                Section {missingSplit.join(', ')} splits into {split.filter((s) => missingSplit.includes(s[0])).join('/')}{' '}
                in the timetable, but no ranges or list say who is in which. Those students can't see their{' '}
                {split.filter((s) => missingSplit.includes(s[0])).join('/')} classes yet.
              </p>
            )}
            {myRanges.length > 0 ? (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Section</th>
                    <th>Admission year</th>
                    <th>Rolls</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {myRanges.map((r) => (
                    <tr key={r.id}>
                      <td>{r.section}</td>
                      <td>{r.admissionYear}</td>
                      <td>
                        {r.minRoll}–{r.maxRoll} ({r.maxRoll - r.minRoll + 1})
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          onClick={() =>
                            setDraft({ id: r.id, admissionYear: r.admissionYear, section: r.section, minRoll: String(r.minRoll), maxRoll: String(r.maxRoll) })
                          }
                        >
                          Edit
                        </button>{' '}
                        <button type="button" onClick={() => remove(r)} style={{ color: 'var(--danger)' }}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="meta">No roll ranges for this batch yet.</p>
            )}
            {problems.length > 0 && (
              <div className="gap-warning card" style={{ padding: 12 }}>
                {problems.map((p) => (
                  <div key={p}>{p}</div>
                ))}
              </div>
            )}

            {draft ? (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label>
                  Section
                  <input value={draft.section} placeholder="e.g. B1" onChange={(e) => setDraft({ ...draft, section: e.target.value.toUpperCase() })} style={{ width: 90 }} />
                </label>
                <label>
                  Admission year
                  <input value={draft.admissionYear} placeholder="2024" onChange={(e) => setDraft({ ...draft, admissionYear: e.target.value.trim() })} style={{ width: 110 }} />
                </label>
                <label>
                  From roll
                  <input value={draft.minRoll} inputMode="numeric" onChange={(e) => setDraft({ ...draft, minRoll: e.target.value.trim() })} style={{ width: 100 }} />
                </label>
                <label>
                  To roll
                  <input value={draft.maxRoll} inputMode="numeric" onChange={(e) => setDraft({ ...draft, maxRoll: e.target.value.trim() })} style={{ width: 100 }} />
                </label>
                <button type="button" className="primary" disabled={saving} onClick={save}>
                  {saving ? 'Saving...' : draft.id ? 'Save' : 'Add range'}
                </button>
                <button type="button" onClick={() => { setDraft(null); setError('') }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setDraft({ admissionYear: myRanges[0]?.admissionYear ?? '', section: '', minRoll: '', maxRoll: '' })}
              >
                + Add a range
              </button>
            )}
            {error && <p className="error">{error}</p>}
          </div>
          )}

          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2>Students</h2>
            <p className="subtitle">
              {mine.length} from uploaded lists, the rest matched by roll range
              {lastUpdate ? ` · list last updated ${new Date(lastUpdate).toLocaleString()}` : ''}
            </p>
            <StudentTable
              rows={buildStudentRows(mine, myRanges, batch.branch)}
              fileName={`${batch.program}-${batch.branch}-sem${batch.semester}-students`}
            />
          </div>
        </>
      )}
    </div>
  )
}
