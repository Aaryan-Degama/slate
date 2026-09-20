import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import { listAll } from './lib/listAll'
import { parseRoll } from '../amplify/functions/shared/attendance'

const client = generateClient<Schema>()

type Enrollment = {
  id: string
  rollId: string
  courseId: string
  action: 'ADD' | 'DROP'
  program: string
  branch: string
  semester: number
  section?: string | null
}
type SlotRow = { courseId: string; program: string; branch: string; semester: number; section: string }
type Input = Omit<Enrollment, 'id'>
type Result = Promise<{ errors?: { message: string }[] }>
const create = client.models.Enrollment.create as unknown as (a: Input) => Result
const remove = client.models.Enrollment.delete as unknown as (a: { id: string }) => Result

const HEADER = 'roll,course,action,program,branch,semester,section'
const EXAMPLE = `${HEADER}
IIT2023045,IML,ADD,BTech,IT,5,C
IIT2023045,DAA,DROP,BTech,IT,7,
IIT2024245,NLP,ADD,BTech,IT,5,*`

/** Exceptions to "a student attends their home section's classes": who takes
 * a course with another section/batch (ADD) or doesn't take one (DROP), and
 * elective choices (ADD with section '*'). */
export default function AdminEnrollments() {
  const [rows, setRows] = useState<Enrollment[] | null>(null)
  const [slots, setSlots] = useState<SlotRow[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const load = () =>
    Promise.all([listAll<Enrollment>(client.models.Enrollment.list), listAll<SlotRow>(client.models.TimetableSlot.list)])
      .then(([e, s]) => {
        setRows(e.data)
        setSlots(s.data)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  useEffect(() => {
    load()
  }, [])

  // Parse + check every line against the ingested timetable before writing anything.
  const parsed = useMemo(() => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines[0]?.toLowerCase().startsWith('roll')) lines.shift()
    return lines.map((line, i) => {
      const [roll = '', course = '', action = '', program = '', branch = '', semester = '', section = ''] = line.split(',').map((c) => c.trim())
      const p = parseRoll(roll)
      const act = action.toUpperCase()
      const sem = Number(semester)
      const problems: string[] = []
      if (!p) problems.push(`"${roll}" isn't a roll number like IIT2023045`)
      if (act !== 'ADD' && act !== 'DROP') problems.push('action must be ADD or DROP')
      const batch = slots.filter((r) => r.program === program && r.branch.toUpperCase() === branch.toUpperCase() && r.semester === sem && r.courseId === course)
      if (!batch.length) problems.push(`${course} isn't in the ${program} ${branch} Sem ${semester} timetable`)
      else if (act === 'ADD') {
        const sec = section.toUpperCase()
        if (!sec) problems.push('ADD needs the section attended (or * for an elective)')
        else if (!batch.some((r) => (sec === '*' ? r.section === '*' : r.section === sec || r.section[0] === sec || sec[0] === r.section)))
          problems.push(`${course} has no Sec ${sec} class in that batch`)
      }
      const value: Input = {
        rollId: p?.rollId ?? roll,
        courseId: course,
        action: act as Input['action'],
        program,
        branch: batch[0]?.branch ?? branch,
        semester: sem,
        ...(act === 'ADD' ? { section: section.toUpperCase() } : {}),
      }
      return { line: i + 1, value, problems }
    })
  }, [text, slots])

  if (error && !rows) return <p className="error">Couldn't load enrollments: {error}</p>
  if (!rows) return <p>Loading enrollments...</p>

  const bad = parsed.filter((r) => r.problems.length)
  const save = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const existing = new Set(rows.map((r) => `${r.rollId}|${r.courseId}|${r.action}|${r.program}|${r.branch}|${r.semester}|${r.section ?? ''}`))
      let added = 0
      for (const { value } of parsed) {
        if (existing.has(`${value.rollId}|${value.courseId}|${value.action}|${value.program}|${value.branch}|${value.semester}|${value.section ?? ''}`)) continue
        const res = await create(value)
        if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
        added++
      }
      setNote(`Saved ${added} enrollment(s)${parsed.length - added ? `, ${parsed.length - added} already there` : ''}.`)
      setText('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const del = async (id: string) => {
    setBusy(true)
    try {
      const res = await remove({ id })
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const sorted = [...rows].sort((a, b) => a.rollId.localeCompare(b.rollId) || a.courseId.localeCompare(b.courseId))
  return (
    <div className="dashboard">
      <p className="eyebrow">Admin</p>
      <h1>Enrollments</h1>
      <p>
        By default every student attends their home section's classes. Add exceptions here: a course taken with another
        section or batch (ADD, e.g. a drop-year student), a course not taken (DROP), and elective choices (ADD with
        section <code>*</code>). Students see the result on their timetable; the slot finder checks them when a class is
        moved.
      </p>
      <label>
        Paste CSV ({HEADER})
        <textarea rows={6} value={text} placeholder={EXAMPLE} onChange={(e) => setText(e.target.value)} />
      </label>
      {parsed.length > 0 && (
        <p className={bad.length ? 'error' : 'meta'}>
          {parsed.length} row(s){bad.length ? `, ${bad.length} with problems: ` : ', all look right.'}
          {bad.map((r) => `line ${r.line}: ${r.problems.join('; ')}`).join(' · ')}
        </p>
      )}
      <button type="button" className="primary" disabled={busy || !parsed.length || bad.length > 0} onClick={save}>
        {busy ? 'Saving...' : 'Save enrollments'}
      </button>
      {note && <p className="meta">{note}</p>}
      {error && <p className="error">{error}</p>}

      <h2>Current exceptions ({rows.length})</h2>
      {sorted.length === 0 ? (
        <p className="meta">None yet: everyone follows their home section.</p>
      ) : (
        <ul className="change-history">
          {sorted.map((r) => (
            <li key={r.id}>
              <span className={`kind ${r.action === 'ADD' ? 'added' : 'cancelled'}`}>{r.action}</span>
              <span>
                <strong>{r.rollId}</strong> · {r.courseId} · {r.program} {r.branch} Sem {r.semester}
                {r.section ? ` · Sec ${r.section}` : ''}
              </span>
              <button type="button" disabled={busy} onClick={() => del(r.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
