import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, type BusyEntry, type Cell } from './lib/grid'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

// Amplify type-inference workaround (see NOTES.md §15): generated
// .create()/.list() types collapse to a bogus shape, so typed by hand.
// sections/constraints are AWSJSON, hence stringified.
type SlotRequestInput = { requesterId: string; status: 'PROPOSED' | 'CONFIRMED'; sections: string; constraints: string }
const createSlotRequest = client.models.SlotRequest.create as unknown as (
  input: SlotRequestInput,
) => Promise<{ data: { id: string } | null; errors?: { message: string }[] }>
const updateSlotRequest = client.models.SlotRequest.update as unknown as (input: {
  id: string
  status: 'CONFIRMED'
}) => Promise<{ errors?: { message: string }[] }>
type ScheduleChangeInput = {
  relatedRequestId: string
  program: string
  branch: string
  section: string
  day: string
  startTime: string
  endTime: string
  courseId: string
  room?: string | null
  changeType: 'SCHEDULED'
}
const createScheduleChange = client.models.ScheduleChange.create as unknown as (
  input: ScheduleChangeInput,
) => Promise<{ errors?: { message: string }[] }>
const findSlots = (client.queries as unknown as {
  findSlots: (a: {
    groups: string[]
    earliestTime?: string
    latestTime?: string
    allowedDays?: string[]
    minDurationMins?: number
  }) => Promise<{ data: unknown; errors?: { message: string }[] }>
}).findSlots

type SlotRow = BusyEntry & { program: string; branch: string; semester: number; section: string }
type Group = { key: string; program: string; branch: string; semester: number; section: string }
type Proposed = { day: string; start: string; end: string; score: number; reason: string; room: string | null }
type Result = {
  slots: Proposed[]
  totalFree: number
  blocking: { section: string; unlocks: number; example: string | null; detail: string } | null
}

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI']
// Same rule as the find-slots Lambda: B1/B2 classes occupy part of B, B classes all of B1/B2.
const blocks = (rowSection: string, g: string) =>
  rowSection === g || rowSection === g[0] || (g.length === 1 && rowSection[0] === g && rowSection.length === 2)
const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE

export default function NewRequest({ requesterId }: { requesterId: string }) {
  const [slots, setSlots] = useState<SlotRow[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [purpose, setPurpose] = useState('')
  const [earliestTime, setEarliestTime] = useState('09:00')
  const [latestTime, setLatestTime] = useState('17:30')
  const [allowedDays, setAllowedDays] = useState<string[]>(DAYS)
  const [minDurationMins, setMinDurationMins] = useState(60)
  const [status, setStatus] = useState<'idle' | 'submitting' | 'results' | 'confirmed'>('idle')
  const [error, setError] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [confirming, setConfirming] = useState<Proposed | null>(null)
  const [confirmed, setConfirmed] = useState<Proposed | null>(null)

  useEffect(() => {
    listAll<SlotRow>(client.models.TimetableSlot.list).then(({ data }) => setSlots(data))
  }, [])

  const groups = useMemo(() => {
    const seen = new Map<string, Group>()
    for (const r of slots ?? []) {
      const key = `${r.program}|${r.branch}|${r.semester}|${r.section}`
      if (!seen.has(key)) seen.set(key, { key, program: r.program, branch: r.branch, semester: r.semester, section: r.section })
    }
    return [...seen.values()].sort(
      (a, b) => a.program.localeCompare(b.program) || a.branch.localeCompare(b.branch) || a.semester - b.semester || a.section.localeCompare(b.section),
    )
  }, [slots])
  const batches = useMemo(() => {
    const m = new Map<string, Group[]>()
    for (const g of groups) {
      const k = `${g.program} ${g.branch} — Semester ${g.semester}`
      m.set(k, [...(m.get(k) ?? []), g])
    }
    return [...m.entries()]
  }, [groups])
  const chosen = groups.filter((g) => picked.includes(g.key))

  // Grid: a cell is busy if any chosen section has a class then.
  const grid: Cell[][] | null = useMemo(() => {
    if (!result || !slots) return null
    const busy = slots.filter((r) =>
      chosen.some((g) => r.program === g.program && r.branch === g.branch && r.semester === g.semester && blocks(r.section, g.section)),
    )
    return buildGrid(busy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, slots])

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))
  const toggleDay = (d: string) => setAllowedDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chosen.length) return setError('Pick at least one section.')
    if (!purpose.trim()) return setError('Say what this session is for.')
    setStatus('submitting')
    setError('')
    try {
      const created = await createSlotRequest({
        requesterId,
        status: 'PROPOSED',
        sections: JSON.stringify(chosen.map(({ program, branch, semester, section }) => ({ program, branch, semester, section }))),
        constraints: JSON.stringify({ earliestTime, latestTime, allowedDays, minDurationMins }),
      })
      if (created.errors?.length) throw new Error(created.errors.map((e) => e.message).join('; '))
      if (!created.data?.id) throw new Error('Request was not saved.')
      setRequestId(created.data.id)

      const res = await findSlots({ groups: chosen.map((g) => g.key), earliestTime, latestTime, allowedDays, minDurationMins })
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      let payload = res.data
      while (typeof payload === 'string') payload = JSON.parse(payload)
      setResult(payload as Result)
      setStatus('results')
    } catch (err) {
      setStatus('idle')
      const msg = err instanceof Error ? err.message : 'Something went wrong.'
      setError(/not authorized|unauthorized/i.test(msg) ? 'Only faculty can schedule sessions.' : msg)
    }
  }

  const confirm = async (slot: Proposed) => {
    if (!requestId) return
    setConfirming(slot)
    setError('')
    try {
      for (const g of chosen) {
        const res = await createScheduleChange({
          relatedRequestId: requestId,
          program: g.program,
          branch: g.branch,
          section: g.section,
          day: slot.day,
          startTime: slot.start,
          endTime: slot.end,
          courseId: purpose.trim(),
          room: slot.room,
          changeType: 'SCHEDULED',
        })
        if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      }
      const upd = await updateSlotRequest({ id: requestId, status: 'CONFIRMED' })
      if (upd.errors?.length) throw new Error(upd.errors.map((e) => e.message).join('; '))
      setConfirmed(slot)
      setStatus('confirmed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm this slot.')
    } finally {
      setConfirming(null)
    }
  }

  const reset = () => {
    setStatus('idle')
    setResult(null)
    setRequestId(null)
    setConfirmed(null)
    setError('')
  }

  if (status === 'confirmed' && confirmed) {
    return (
      <div className="new-request">
        <h1>Scheduled</h1>
        <p>
          "{purpose}" is on {confirmed.day} {confirmed.start}–{confirmed.end}
          {confirmed.room ? ` in ${confirmed.room}` : ''} for{' '}
          {chosen.map((g) => `${g.branch} Sem ${g.semester} Sec ${g.section}`).join(', ')}. It now shows up highlighted
          on those students' timetables.
        </p>
        <button type="button" onClick={reset}>
          Schedule another session
        </button>
      </div>
    )
  }

  if (status === 'results' && result && grid) {
    return (
      <div className="new-request">
        <h1>Proposed slots</h1>
        <p className="subtitle">
          "{purpose}" for {chosen.map((g) => `${g.branch} Sem ${g.semester} Sec ${g.section}`).join(', ')} ·{' '}
          {result.totalFree} slot(s) free for everyone
        </p>

        {result.slots.length > 0 ? (
          <div className="proposed-list">
            {result.slots.map((s, i) => (
              <div key={`${s.day}-${s.start}`} className={`card proposed${i === 0 ? ' best' : ''}`}>
                <div className="proposed-head">
                  <strong>
                    {s.day} {s.start}–{s.end}
                  </strong>
                  {i === 0 && <span className="tag">Best fit</span>}
                  <span className="meta">{s.room ? `Room ${s.room} is free` : 'No free room found'}</span>
                </div>
                <p className="meta">{s.reason}</p>
                <button type="button" className="primary" disabled={confirming !== null} onClick={() => confirm(s)}>
                  {confirming === s ? 'Scheduling...' : 'Schedule this'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="card gap-warning">
            <h2>No common slot</h2>
            <p>{result.blocking?.detail ?? 'No slot fits these constraints.'}</p>
          </div>
        )}

        <h2>Everyone's week</h2>
        <TimetableGrid grid={markFree(grid, result.slots)} freeIsHighlighted />
        {error && <p className="error">{error}</p>}
        <button type="button" onClick={reset}>
          Change the request
        </button>
      </div>
    )
  }

  return (
    <form className="new-request" onSubmit={submit}>
      <h1>Schedule a session</h1>

      <label>
        What's this session for?
        <input placeholder="e.g. IML makeup class" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>

      <p>Which sections need to attend?</p>
      {!slots && <p className="meta">Loading sections...</p>}
      {batches.map(([name, gs]) => (
        <div key={name} className="section-pick">
          <span className="meta">{name}</span>
          <div className="option-list">
            {gs.map((g) => (
              <button
                type="button"
                key={g.key}
                className={picked.includes(g.key) ? 'active' : ''}
                onClick={() => toggle(g.key)}
              >
                Sec {g.section}
              </button>
            ))}
          </div>
        </div>
      ))}

      <fieldset>
        <legend>Constraints</legend>
        <label>
          Earliest start
          <input type="time" value={earliestTime} onChange={(e) => setEarliestTime(e.target.value)} />
        </label>
        <label>
          Latest end
          <input type="time" value={latestTime} onChange={(e) => setLatestTime(e.target.value)} />
        </label>
        <label>
          Length
          <select value={minDurationMins} onChange={(e) => setMinDurationMins(Number(e.target.value))}>
            <option value={60}>1 hour</option>
            <option value={120}>2 hours</option>
            <option value={180}>3 hours</option>
          </select>
        </label>
        <div className="days">
          {DAYS.map((d) => (
            <label key={d} className="day-toggle">
              <input type="checkbox" checked={allowedDays.includes(d)} onChange={() => toggleDay(d)} />
              {d}
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Finding slots...' : 'Find free slots'}
      </button>
    </form>
  )
}

/** Only the proposed slots' hours count as "free" in the grid (not every empty cell outside the constraints). */
function markFree(grid: Cell[][], proposed: Proposed[]): Cell[][] {
  return grid.map((row) =>
    row.map((cell) =>
      cell.busy.length === 0 && !proposed.some((p) => p.day === cell.day && overlaps(cell.start, cell.end, p.start, p.end))
        ? { ...cell, outside: true }
        : cell,
    ),
  )
}
