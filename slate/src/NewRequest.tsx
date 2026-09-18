import { useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'

const client = generateClient<Schema>()

// Workaround: with the currently installed aws-amplify / @aws-amplify/backend
// versions, TypeScript's generated .create() parameter type collapses to a
// bogus `{ [x: string]: string[] }` shape for every model, regardless of the
// actual schema (confirmed by testing a single-field model in isolation —
// same broken type, independent of TS version and node_modules deduping).
// This only affects compile-time type-checking; the GraphQL call itself is
// unaffected. Typed manually here instead of fighting the inference bug.
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
) => Promise<unknown>

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

type Section = { program: string; branch: string; section: string }

const emptySection: Section = { program: '', branch: '', section: '' }

export default function NewRequest({ requesterId }: { requesterId: string }) {
  const [sections, setSections] = useState<Section[]>([{ ...emptySection }])
  const [earliestTime, setEarliestTime] = useState('09:00')
  const [latestTime, setLatestTime] = useState('17:00')
  const [allowedDays, setAllowedDays] = useState<string[]>(DAYS)
  const [minDurationMins, setMinDurationMins] = useState(60)
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')

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
    setStatus('submitting')
    setErrorMessage('')
    try {
      await createSlotRequest({
        requesterId,
        status: 'PROPOSED',
        sections: validSections,
        constraints: { earliestTime, latestTime, allowedDays, minDurationMins },
      })
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  if (status === 'done') {
    return (
      <div className="new-request">
        <h1>Request submitted</h1>
        <p>
          We'll compute the common free slots for the sections you picked. The
          Proposed Slots screen isn't wired up yet — for now this just confirms
          the request was saved.
        </p>
        <button type="button" onClick={() => setStatus('idle')}>
          Submit another request
        </button>
      </div>
    )
  }

  return (
    <form className="new-request" onSubmit={handleSubmit}>
      <h1>New Request</h1>
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
        {status === 'submitting' ? 'Submitting...' : 'Find free slots'}
      </button>
    </form>
  )
}
