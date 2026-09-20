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
  mondayOf,
  todayIst,
  type BusyEntry,
  type Cell,
} from './lib/grid'
import { addExtra, moveOccurrence } from './lib/classReps'
import { fetchMyTimetable, type Meeting, type MyTimetable } from './lib/rollLookup'

const client = generateClient<Schema>()

// Amplify type-inference workaround (see NOTES.md §15): generated
// query types collapse to a bogus shape, so typed by hand.
const findSlots = (client.queries as unknown as {
  findSlots: (a: {
    offeringKey: string
    dates: string[]
    ignoreMeetingId?: string
    earliestTime?: string
    latestTime?: string
    minDurationMins?: number
  }) => Promise<{ data: unknown; errors?: { message: string }[] }>
}).findSlots

type Proposed = { date: string; day: string; start: string; end: string; score: number; reason: string; room: string | null }
type Result = {
  slots: Proposed[]
  totalFree: number
  attendees: number
  profiles: number
  professors: string[]
  course: string
  sections: string[]
  blocking: { who: string; students: number; blocks: number; example: string | null; detail: string } | null
}
type Occurrence = { meeting: Meeting; date: string }

const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE

/** CR tool: add an extra class for one of their courses, or move one of its
 * classes, to a slot free for every student registered in it and for the
 * professor who teaches it (docs/DATA-MODEL.md). */
export default function NewRequest({ isCr }: { isCr: boolean }) {
  const [me, setMe] = useState<MyTimetable | null | undefined>(undefined)
  const [mode, setMode] = useState<'extra' | 'move'>('extra')
  const [offeringKey, setOfferingKey] = useState('')
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
    fetchMyTimetable()
      .then(setMe)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const today = todayIst()
  const monday = mondayOf(today)
  const dates = [
    ...(weeks !== 'next' ? DAYS.map((d) => dateIn(monday, d)) : []),
    ...(weeks !== 'this' ? DAYS.map((d) => dateIn(addDays(monday, 7), d)) : []),
  ].filter((d) => d >= today)

  // Upcoming meetings of the chosen course, over the two weeks in view.
  const occurrences: Occurrence[] = useMemo(() => {
    if (!me || !offeringKey) return []
    return dates.flatMap((date) =>
      me.meetings.filter((m) => m.offeringKey === offeringKey && m.day === DAYS[new Date(`${date}T00:00:00Z`).getUTCDay() - 1]).map((meeting) => ({ meeting, date })),
    )
  }, [me, offeringKey, dates])

  if (!isCr) return <p className="meta">Only a section's CR can change the timetable. Your CR is shown on My Timetable.</p>
  if (me === undefined) return <p>{error || 'Loading...'}</p>
  if (!me) return <p className="error">Your roll number isn't in the uploaded student lists yet. Ask your admin.</p>

  const offerings = [...me.offerings].sort((a, b) => a.courseCode.localeCompare(b.courseCode))
  const offering = offerings.find((o) => o.offeringKey === offeringKey)

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!offeringKey) return setError('Pick a course.')
    if (mode === 'move' && !occurrence) return setError('Pick which class to move.')
    if (!dates.length) return setError('No dates left in that range.')
    setStatus('searching')
    setError('')
    try {
      const res = await findSlots({
        offeringKey,
        dates,
        ...(mode === 'move' && occurrence ? { ignoreMeetingId: occurrence.meeting.id } : {}),
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
        await moveOccurrence({ meetingId: occurrence.meeting.id, fromDate: occurrence.date, date: slot.date, startTime: slot.start, endTime: slot.end, room: slot.room })
      else await addExtra({ offeringKey, date: slot.date, startTime: slot.start, endTime: slot.end, room: slot.room })
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

  if (status === 'done' && done && offering) {
    return (
      <div className="new-request">
        <h1>{mode === 'move' ? 'Class moved' : 'Extra class added'}</h1>
        <p>
          {offering.courseCode} is on {formatDate(done.date)} {done.start}–{done.end}
          {done.room ? ` in ${done.room}` : ''}
          {mode === 'move' && occurrence ? `, instead of ${formatDate(occurrence.date)} ${occurrence.meeting.startTime}` : ''}. Everyone
          registered in it sees it on their timetable, with your name on it.
        </p>
        <button type="button" onClick={reset}>
          Make another change
        </button>
      </div>
    )
  }

  if (status === 'results' && result && offering) {
    const week = mondayOf(result.slots[0]?.date ?? dates[0])
    const busy: BusyEntry[] = me.meetings
      .filter((m) => !(mode === 'move' && occurrence && m.id === occurrence.meeting.id))
      .map((m) => ({ id: m.id, day: m.day, startTime: m.startTime, endTime: m.endTime, courseId: m.courseId, room: m.room, section: m.section }))
    return (
      <div className="new-request">
        <h1>
          {mode === 'move' ? 'Move' : 'Extra class for'} {offering.courseCode}
        </h1>
        <p className="subtitle">
          {result.attendees} registered student(s) ({result.profiles} different timetable(s))
          {result.professors.length ? ` · ${result.professors.join(' & ')}` : ''} · {result.totalFree} slot(s) free for
          everyone
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
                <button type="button" className="primary" disabled={saving !== null} onClick={() => save(s)}>
                  {saving === s ? 'Saving...' : mode === 'move' ? 'Move here' : 'Add this class'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="card gap-warning">
            <h2>No slot works</h2>
            <p>{result.blocking?.detail ?? 'No slot fits these constraints.'}</p>
          </div>
        )}

        <h2>Your week · {formatDate(week)}</h2>
        <TimetableGrid
          grid={markFree(buildGrid(busy), result.slots.filter((p) => mondayOf(p.date) === week))}
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
        <select
          value={offeringKey}
          onChange={(e) => {
            setOfferingKey(e.target.value)
            setOccurrence(null)
          }}
        >
          <option value="">Pick a course</option>
          {offerings.map((o) => (
            <option key={o.offeringKey} value={o.offeringKey}>
              {o.courseCode}
              {o.courseName ? ` — ${o.courseName}` : ''}
              {o.faculty ? ` (${o.faculty})` : ''}
            </option>
          ))}
        </select>
      </label>
      {offering && (
        <p className="meta">
          The change reaches everyone registered in this class
          {offering.sections.length ? ` (Sec ${offering.sections.join(', ')})` : ''}.
        </p>
      )}

      {offering && mode === 'move' && (
        <>
          <p>Which class?</p>
          {occurrences.length === 0 && <p className="meta">No {offering.courseCode} classes in the next two weeks.</p>}
          <div className="option-list">
            {occurrences.map((o) => (
              <button
                type="button"
                key={`${o.meeting.id}-${o.date}`}
                className={occurrence === o ? 'active' : ''}
                onClick={() => setOccurrence(o)}
              >
                {formatDate(o.date)} {o.meeting.startTime}–{o.meeting.endTime}
                {o.meeting.sessionType ? ` (${o.meeting.sessionType})` : ''}
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
