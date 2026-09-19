import { useEffect, useMemo, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import {
  addDays,
  buildGrid,
  dateIn,
  DAYS,
  formatDate,
  forWeek,
  mondayOf,
  todayIst,
  type BusyEntry,
  type Cell,
  type ChangeEntry,
} from './lib/grid'
import { listAll } from './lib/listAll'
import { addExtra, moveOccurrence } from './lib/classReps'

const client = generateClient<Schema>()

// Amplify type-inference workaround (see NOTES.md §15): generated
// query types collapse to a bogus shape, so typed by hand.
const findSlots = (client.queries as unknown as {
  findSlots: (a: {
    groups: string[]
    dates: string[]
    courseId?: string
    ignoreSlotId?: string
    earliestTime?: string
    latestTime?: string
    minDurationMins?: number
  }) => Promise<{ data: unknown; errors?: { message: string }[] }>
}).findSlots

type SlotRow = BusyEntry & { id: string; program: string; branch: string; semester: number; section: string; faculty?: string | null }
type ChangeRow = ChangeEntry & { program: string; branch: string; semester: number; section: string }
type Proposed = {
  date: string
  day: string
  start: string
  end: string
  score: number
  reason: string
  room: string | null
  /** Irregular attendees (e.g. drop-year students) who have another class then. */
  clashCount: number
  clashes: { students: string[]; has: string }[]
}
type Result = {
  slots: Proposed[]
  totalFree: number
  totalWithClashes: number
  irregulars: number
  professors: string[]
  blocking: { party: string; kind: string; unlocks: number; example: string | null; detail: string } | null
}
type MySection = { program: string; branch: string; semester: number; section: string }
type Occurrence = { slot: SlotRow; date: string }

/** B covers B1/B2 (same rule as the server's reach()). */
function reach(sections: string[]): string[] {
  const set = new Set(sections)
  return [...set].filter((s) => !(s.length === 2 && set.has(s[0]))).sort()
}
const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE
const blocks = (rowSection: string, g: string) =>
  rowSection === '*' || rowSection === g || rowSection === g[0] || (g.length === 1 && rowSection[0] === g && rowSection.length === 2)

/** CR tool: add an extra class for a course, or move one of its classes,
 * to a slot free for every section taking it and for its professor. The
 * change reaches all those sections (server-checked by Cedar). */
export default function NewRequest({ mySection, isCr }: { mySection: MySection | null; isCr: boolean }) {
  const [slots, setSlots] = useState<SlotRow[] | null>(null)
  const [changes, setChanges] = useState<ChangeRow[]>([])
  const [mode, setMode] = useState<'extra' | 'move'>('extra')
  const [courseId, setCourseId] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [occurrence, setOccurrence] = useState<Occurrence | null>(null)
  const [weeks, setWeeks] = useState<'this' | 'next' | 'both'>('both')
  const [earliestTime, setEarliestTime] = useState('09:00')
  const [latestTime, setLatestTime] = useState('17:30')
  const [minDurationMins, setMinDurationMins] = useState(60)
  const [status, setStatus] = useState<'idle' | 'searching' | 'results' | 'done'>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [saving, setSaving] = useState<Proposed | null>(null)
  const [done, setDone] = useState<Proposed | null>(null)

  useEffect(() => {
    Promise.all([listAll<SlotRow>(client.models.TimetableSlot.list), listAll<ChangeRow>(client.models.ScheduleChange.list)])
      .then(([s, c]) => {
        setSlots(s.data)
        setChanges(c.data.filter((r) => r.date && !r.undoneAt))
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const today = todayIst()
  const batch = useMemo(
    () =>
      mySection && slots
        ? slots.filter((r) => r.program === mySection.program && r.branch === mySection.branch && r.semester === mySection.semester)
        : [],
    [slots, mySection],
  )
  // The courses this CR can act for: the ones their own section takes.
  const myCourses = useMemo(
    () => (mySection ? [...new Set(batch.filter((r) => blocks(r.section, mySection.section)).map((r) => r.courseId))].sort() : []),
    [batch, mySection],
  )
  // The sections an extra class reaches: those taught by the same
  // professor as the CR's own section (IML has a different one per
  // section). Same rule as the server.
  const courseSections = (c: string) => {
    const rows = batch.filter((r) => r.courseId === c && r.section !== '*')
    const profs = new Set(rows.filter((r) => mySection && r.section[0] === mySection.section[0] && r.faculty).map((r) => r.faculty))
    return reach(rows.filter((r) => !profs.size || profs.has(r.faculty)).map((r) => r.section))
  }

  // Upcoming occurrences of the course for this CR's section (next two weeks).
  const occurrences: Occurrence[] = useMemo(() => {
    if (!courseId || !mySection) return []
    const mine = batch.filter((r) => r.courseId === courseId && blocks(r.section, mySection.section))
    const monday = mondayOf(today)
    const out: Occurrence[] = []
    for (let w = 0; w < 2; w++)
      for (const day of DAYS) {
        const date = dateIn(addDays(monday, 7 * w), day)
        if (date < today) continue
        for (const slot of mine.filter((r) => r.day === day)) {
          const off = changes.some(
            (c) => c.date === date && c.relatedSlotId === slot.id && (c.kind === 'CANCELLED' || c.kind === 'MOVED_FROM'),
          )
          if (!off) out.push({ slot, date })
        }
      }
    return out
  }, [courseId, mySection, batch, changes, today])

  if (!isCr) return <p className="meta">Only a section's CR can change the timetable. Your CR is shown on My Timetable.</p>
  if (!mySection) return <p className="error">Your section isn't linked yet. Open My Timetable first.</p>
  if (!slots) return <p>{error || 'Loading...'}</p>

  // A move keeps the class's own sections: every section it's held for together.
  const together = (o: Occurrence) =>
    reach(
      batch
        .filter(
          (r) =>
            r.courseId === o.slot.courseId &&
            r.day === o.slot.day &&
            r.startTime === o.slot.startTime &&
            r.endTime === o.slot.endTime &&
            (r.sessionType ?? '') === (o.slot.sessionType ?? ''),
        )
        .map((r) => r.section),
    )
  const sections = mode === 'move' ? (occurrence ? together(occurrence) : []) : picked
  const chooseCourse = (c: string) => {
    setCourseId(c)
    setPicked(courseSections(c))
    setOccurrence(null)
  }
  const toggle = (s: string) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))

  const monday = mondayOf(today)
  const dates = [
    ...(weeks !== 'next' ? DAYS.map((d) => dateIn(monday, d)) : []),
    ...(weeks !== 'this' ? DAYS.map((d) => dateIn(addDays(monday, 7), d)) : []),
  ].filter((d) => d >= today)

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!courseId) return setError('Pick a course.')
    if (mode === 'move' && !occurrence) return setError('Pick which class to move.')
    if (!sections.length) return setError('Pick at least one section.')
    if (!dates.length) return setError('No dates left in that range.')
    setStatus('searching')
    setError('')
    try {
      const res = await findSlots({
        groups: sections.map((s) => `${mySection.program}|${mySection.branch}|${mySection.semester}|${s}`),
        dates,
        courseId,
        ...(occurrence && mode === 'move' ? { ignoreSlotId: occurrence.slot.id } : {}),
        earliestTime,
        latestTime,
        minDurationMins,
      })
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      let payload = res.data
      while (typeof payload === 'string') payload = JSON.parse(payload)
      setResult(payload as Result)
      setStatus('results')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  const save = async (slot: Proposed) => {
    setSaving(slot)
    setError('')
    try {
      if (mode === 'move' && occurrence)
        await moveOccurrence({ slotId: occurrence.slot.id, fromDate: occurrence.date, date: slot.date, startTime: slot.start, endTime: slot.end, room: slot.room })
      else
        await addExtra({
          courseId,
          date: slot.date,
          startTime: slot.start,
          endTime: slot.end,
          room: slot.room,
          sections: picked.length === courseSections(courseId).length ? [] : picked,
        })
      setDone(slot)
      setStatus('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this change.')
    } finally {
      setSaving(null)
    }
  }

  const reset = () => {
    setStatus('idle')
    setResult(null)
    setDone(null)
    setError('')
  }

  if (status === 'done' && done) {
    return (
      <div className="new-request">
        <h1>{mode === 'move' ? 'Class moved' : 'Extra class added'}</h1>
        <p>
          {courseId} is on {formatDate(done.date)} {done.start}–{done.end}
          {done.room ? ` in ${done.room}` : ''} for Sec {sections.join(', ')}
          {mode === 'move' && occurrence ? `, instead of ${formatDate(occurrence.date)} ${occurrence.slot.startTime}` : ''}. Every
          student in those sections sees it on their timetable, with your name on it.
        </p>
        <button type="button" onClick={reset}>
          Make another change
        </button>
      </div>
    )
  }

  if (status === 'results' && result) {
    // Everyone's week (the week of the first proposed slot, or the first date searched).
    const week = mondayOf(result.slots[0]?.date ?? dates[0])
    const busy = batch.filter((r) => sections.some((s) => blocks(r.section, s)) && !(mode === 'move' && occurrence && r.id === occurrence.slot.id))
    const grid = markFree(
      buildGrid(busy, forWeek(changes.filter((c) => sections.some((s) => blocks(c.section, s))), week)),
      result.slots.filter((p) => mondayOf(p.date) === week),
    )
    return (
      <div className="new-request">
        <h1>{mode === 'move' ? `Move ${courseId}` : `Extra ${courseId} class`}</h1>
        <p className="subtitle">
          Sec {sections.join(', ')}
          {result.professors.length ? ` · ${result.professors.join(' & ')}` : ''}
          {result.irregulars ? ` · ${result.irregulars} attending student(s) with their own timetable` : ''} ·{' '}
          {result.totalFree} slot(s) free for everyone
          {result.totalWithClashes > result.totalFree ? `, ${result.totalWithClashes - result.totalFree} more with a few clashes` : ''}
        </p>

        {result.slots.length > 0 ? (
          <div className="proposed-list">
            {result.slots.map((s, i) => (
              <div key={`${s.date}-${s.start}`} className={`card proposed${i === 0 ? ' best' : ''}`}>
                <div className="proposed-head">
                  <strong>
                    {formatDate(s.date)} {s.start}–{s.end}
                  </strong>
                  {i === 0 && <span className="tag">Best fit</span>}
                  <span className="meta">{s.room ? `Room ${s.room} is free` : 'No free room found'}</span>
                </div>
                <p className="meta">{s.reason}</p>
                {s.clashCount > 0 && (
                  <p className="error">
                    Clashes for {s.clashCount} student(s):{' '}
                    {s.clashes.map((c) => `${c.students.join(', ')} (${c.has})`).join('; ')}. Tell them directly if you pick it.
                  </p>
                )}
                <button type="button" className="primary" disabled={saving !== null} onClick={() => save(s)}>
                  {saving === s ? 'Saving...' : mode === 'move' ? 'Move here' : 'Add this class'}
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

        <h2>Everyone's week · {formatDate(week)}</h2>
        <TimetableGrid
          grid={grid}
          freeIsHighlighted
          dayLabels={Object.fromEntries(DAYS.map((d) => [d, formatDate(dateIn(week, d))]))}
        />
        {error && <p className="error">{error}</p>}
        <button type="button" onClick={reset}>
          Change the request
        </button>
      </div>
    )
  }

  return (
    <form className="new-request" onSubmit={search}>
      <h1>Make a change</h1>
      <div className="option-list">
        <button type="button" className={mode === 'extra' ? 'active' : ''} onClick={() => setMode('extra')}>
          Extra class
        </button>
        <button type="button" className={mode === 'move' ? 'active' : ''} onClick={() => setMode('move')}>
          Move a class
        </button>
      </div>
      <p className="meta">To cancel a class, click it on My Timetable.</p>

      <label>
        Course
        <select value={courseId} onChange={(e) => chooseCourse(e.target.value)}>
          <option value="">Pick a course</option>
          {myCourses.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      {courseId && mode === 'extra' && (
        <>
          <p>Sections this {courseId} professor teaches (all included by default):</p>
          <div className="option-list">
            {courseSections(courseId).map((s) => (
              <button type="button" key={s} className={picked.includes(s) ? 'active' : ''} onClick={() => toggle(s)}>
                Sec {s}
              </button>
            ))}
          </div>
        </>
      )}

      {courseId && mode === 'move' && (
        <>
          <p>Which class?</p>
          {occurrences.length === 0 && <p className="meta">No upcoming {courseId} classes for your section in the next two weeks.</p>}
          <div className="option-list">
            {occurrences.map((o) => (
              <button
                type="button"
                key={`${o.slot.id}-${o.date}`}
                className={occurrence === o ? 'active' : ''}
                onClick={() => setOccurrence(o)}
              >
                {formatDate(o.date)} {o.slot.startTime}–{o.slot.endTime}
                {o.slot.sessionType ? ` (${o.slot.sessionType})` : ''} · Sec {together(o).join(', ')}
              </button>
            ))}
          </div>
        </>
      )}

      <fieldset>
        <legend>When</legend>
        <label>
          Weeks
          <select value={weeks} onChange={(e) => setWeeks(e.target.value as typeof weeks)}>
            <option value="this">This week</option>
            <option value="next">Next week</option>
            <option value="both">This week and next</option>
          </select>
        </label>
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
      </fieldset>

      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={status === 'searching'}>
        {status === 'searching' ? 'Finding slots...' : 'Find free slots'}
      </button>
    </form>
  )
}

/** Only the proposed slots' hours count as "free" in the grid (not every empty cell). */
function markFree(grid: Cell[][], proposed: Proposed[]): Cell[][] {
  return grid.map((row) =>
    row.map((cell) =>
      cell.busy.length === 0 && !proposed.some((p) => p.day === cell.day && overlaps(cell.start, cell.end, p.start, p.end))
        ? { ...cell, outside: true }
        : cell,
    ),
  )
}
