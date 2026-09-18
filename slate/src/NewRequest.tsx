import { useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { freeAcrossAll, type BusyEntry, type Cell } from './lib/grid'

const client = generateClient<Schema>()

// Workaround: see NOTES.md §15 — the installed Amplify version's generated
// .create()/.list() parameter/return types collapse to a bogus shape
// regardless of the actual schema. Typed manually here instead.
type Section = { program: string; branch: string; section: string }

type SlotRequestInput = {
  requesterId: string
  status: 'PROPOSED' | 'CONFIRMED'
  sections: Section[]
  constraints: {
    earliestTime: string
    latestTime: string
    allowedDays: string[]
    minDurationMins: number
  }
}
const createSlotRequest = client.models.SlotRequest.create as unknown as (
  input: SlotRequestInput,
) => Promise<{ data: { id: string } | null }>

const updateSlotRequest = client.models.SlotRequest.update as unknown as (
  input: { id: string; status: 'CONFIRMED' },
) => Promise<unknown>

type TimetableSlotRow = {
  program: string
  branch: string
  section: string
  day: string
  startTime: string
  endTime: string
  courseId: string
  room?: string | null
  faculty?: string | null
}
const listTimetableSlots = client.models.TimetableSlot.list as unknown as () => Promise<{
  data: TimetableSlotRow[]
}>

type ScheduleChangeInput = {
  relatedRequestId: string
  program: string
  branch: string
  section: string
  day: string
  startTime: string
  endTime: string
  courseId: string
  changeType: 'SCHEDULED'
}
const createScheduleChange = client.models.ScheduleChange.create as unknown as (
  input: ScheduleChangeInput,
) => Promise<unknown>

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const emptySection: Section = { program: '', branch: '', section: '' }

export default function NewRequest({ requesterId }: { requesterId: string }) {
  const [sections, setSections] = useState<Section[]>([{ ...emptySection }])
  const [purpose, setPurpose] = useState('')
  const [earliestTime, setEarliestTime] = useState('09:00')
  const [latestTime, setLatestTime] = useState('17:00')
  const [allowedDays, setAllowedDays] = useState<string[]>(DAYS)
  const [minDurationMins, setMinDurationMins] = useState(60)
  const [status, setStatus] = useState<'idle' | 'submitting' | 'results' | 'confirmed' | 'error'>(
    'idle',
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [grid, setGrid] = useState<Cell[][] | null>(null)
  const [confirming, setConfirming] = useState<Cell | null>(null)

  const updateSection = (index: number, patch: Partial<Section>) => {
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const addSection = () => setSections((prev) => [...prev, { ...emptySection }])

  const removeSection = (index: number) =>
    setSections((prev) => prev.filter((_, i) => i !== index))

  const toggleDay = (day: string) =>
    setAllowedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    )

  const validSections = sections.filter((s) => s.program && s.branch && s.section)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (validSections.length === 0) {
      setErrorMessage('Add at least one section.')
      return
    }
    if (!purpose.trim()) {
      setErrorMessage('Say what this session is for.')
      return
    }
    setStatus('submitting')
    setErrorMessage('')
    try {
      const created = await createSlotRequest({
        requesterId,
        status: 'PROPOSED',
        sections: validSections,
        constraints: { earliestTime, latestTime, allowedDays, minDurationMins },
      })
      const id = created.data?.id
      if (!id) throw new Error('Request was not saved.')
      setRequestId(id)

      const all = await listTimetableSlots()
      const perSection: BusyEntry[][] = validSections.map((sec) =>
        all.data.filter(
          (row) =>
            row.program === sec.program &&
            row.branch === sec.branch &&
            row.section === sec.section,
        ),
      )
      setGrid(freeAcrossAll(perSection))
      setStatus('results')
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  const handleConfirm = async (cell: Cell) => {
    if (!requestId) return
    setConfirming(cell)
    try {
      await Promise.all(
        validSections.map((sec) =>
          createScheduleChange({
            relatedRequestId: requestId,
            program: sec.program,
            branch: sec.branch,
            section: sec.section,
            day: cell.day,
            startTime: cell.start,
            endTime: cell.end,
            courseId: purpose,
            changeType: 'SCHEDULED',
          }),
        ),
      )
      await updateSlotRequest({ id: requestId, status: 'CONFIRMED' })
      setStatus('confirmed')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not confirm this slot.')
      setConfirming(null)
    }
  }

  const reset = () => {
    setStatus('idle')
    setGrid(null)
    setRequestId(null)
    setConfirming(null)
    setErrorMessage('')
  }

  if (status === 'confirmed') {
    return (
      <div className="new-request">
        <h1>Confirmed</h1>
        <p>
          "{purpose}" is now scheduled. Everyone in the affected sections will see it
          highlighted on their own timetable dashboard.
        </p>
        <button type="button" onClick={reset}>
          Submit another request
        </button>
      </div>
    )
  }

  if (status === 'results' && grid) {
    return (
      <div className="new-request">
        <h1>Proposed Slots</h1>
        <p>
          Green cells are free for every selected section. Click one to schedule "
          {purpose}" there.
        </p>
        <TimetableGrid
          grid={grid}
          freeIsHighlighted
        />
        <FreeCellPicker grid={grid} onPick={handleConfirm} confirming={confirming} />
        {errorMessage && <p className="error">{errorMessage}</p>}
        <button type="button" onClick={reset}>
          Start over
        </button>
      </div>
    )
  }

  return (
    <form className="new-request" onSubmit={handleSubmit}>
      <h1>New Request</h1>

      <label>
        What's this session for?
        <input
          placeholder="e.g. Makeup class for Module 3"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        />
      </label>

      <p>Which sections need to attend?</p>

      {sections.map((section, i) => (
        <div className="section-row" key={i}>
          <input
            placeholder="Program (e.g. BTech)"
            value={section.program}
            onChange={(e) => updateSection(i, { program: e.target.value })}
          />
          <input
            placeholder="Branch (e.g. IT)"
            value={section.branch}
            onChange={(e) => updateSection(i, { branch: e.target.value })}
          />
          <input
            placeholder="Section (e.g. A)"
            value={section.section}
            onChange={(e) => updateSection(i, { section: e.target.value })}
          />
          {sections.length > 1 && (
            <button type="button" onClick={() => removeSection(i)} aria-label="Remove section">
              &times;
            </button>
          )}
        </div>
      ))}
      <button type="button" onClick={addSection}>
        + Add another section
      </button>

      <fieldset>
        <legend>Constraints (optional)</legend>

        <label>
          Earliest time
          <input
            type="time"
            value={earliestTime}
            onChange={(e) => setEarliestTime(e.target.value)}
          />
        </label>

        <label>
          Latest time
          <input
            type="time"
            value={latestTime}
            onChange={(e) => setLatestTime(e.target.value)}
          />
        </label>

        <label>
          Minimum duration (minutes)
          <input
            type="number"
            min={15}
            step={15}
            value={minDurationMins}
            onChange={(e) => setMinDurationMins(Number(e.target.value))}
          />
        </label>

        <div className="days">
          {DAYS.map((day) => (
            <label key={day} className="day-toggle">
              <input
                type="checkbox"
                checked={allowedDays.includes(day)}
                onChange={() => toggleDay(day)}
              />
              {day}
            </label>
          ))}
        </div>
      </fieldset>

      {errorMessage && <p className="error">{errorMessage}</p>}

      <button type="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Finding slots...' : 'Find free slots'}
      </button>
    </form>
  )
}

// Free cells aren't individually clickable inside the plain <table> grid
// (that'd complicate TimetableGrid for the read-only dashboard use case
// too), so list them as buttons underneath instead.
function FreeCellPicker({
  grid,
  onPick,
  confirming,
}: {
  grid: Cell[][]
  onPick: (cell: Cell) => void
  confirming: Cell | null
}) {
  const free = grid.flat().filter((c) => c.busy.length === 0 && !c.change)
  if (free.length === 0) {
    return <p>No common free slot across every selected section.</p>
  }
  return (
    <div className="free-slot-picker">
      {free.map((cell) => (
        <button
          key={`${cell.day}-${cell.start}`}
          type="button"
          disabled={confirming !== null}
          onClick={() => onPick(cell)}
        >
          {confirming === cell
            ? 'Scheduling...'
            : `${cell.day} ${cell.start}–${cell.end}`}
        </button>
      ))}
    </div>
  )
}
