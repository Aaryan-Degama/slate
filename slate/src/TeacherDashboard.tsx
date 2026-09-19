import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, type BusyEntry, type ChangeEntry } from './lib/grid'
import type { Profile } from './lib/useMyProfile'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type TimetableSlotRow = BusyEntry & { faculty?: string | null }
const listTimetableSlots = () => listAll<TimetableSlotRow>(client.models.TimetableSlot.list)
const listScheduleChanges = () => listAll<ChangeEntry>(client.models.ScheduleChange.list)
const cancelClass = (client.mutations as unknown as {
  cancelClass: (a: { slotIds: string[] }) => Promise<{ errors?: { message: string }[] }>
}).cancelClass

export default function TeacherDashboard({
  profile,
  linkFacultyName,
}: {
  profile: Profile
  linkFacultyName: (name: string) => Promise<void>
}) {
  if (!profile.linkedFacultyName) return <FacultyPicker onPick={linkFacultyName} />

  return <MyTeachingTimetable facultyName={profile.linkedFacultyName} />
}

function FacultyPicker({ onPick }: { onPick: (name: string) => void }) {
  const [names, setNames] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listTimetableSlots().then(({ data }) => {
      const set = new Set<string>()
      for (const row of data) if (row.faculty) set.add(row.faculty)
      setNames([...set].sort())
      setLoading(false)
    })
  }, [])

  if (loading) return <p>Loading faculty list...</p>

  return (
    <div className="identity-link">
      <h1>Which of these is you?</h1>
      <p>Not set. Pick your real name as it appears in the timetable.</p>
      <div className="option-list">
        {names.map((name) => (
          <button key={name} type="button" onClick={() => onPick(name)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

function MyTeachingTimetable({ facultyName }: { facultyName: string }) {
  const [slots, setSlots] = useState<TimetableSlotRow[] | null>(null)
  const [changes, setChanges] = useState<ChangeEntry[]>([])
  const [picked, setPicked] = useState<BusyEntry | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')

  const load = () =>
    Promise.all([listTimetableSlots(), listScheduleChanges()]).then(([s, c]) => {
      setSlots(s.data.filter((r) => r.faculty === facultyName))
      setChanges(c.data)
    })

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facultyName])

  if (!slots) return <p>Loading your timetable...</p>

  const grid = buildGrid(slots, changes)

  const cancel = async (entry: BusyEntry) => {
    setCancelling(true)
    setError('')
    try {
      const ids = entry.mergedIds ?? (entry.id ? [entry.id] : [])
      const res = await cancelClass({ slotIds: ids })
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      await load()
      setPicked(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel this class.')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="dashboard">
      <h1>My Teaching Timetable — {facultyName}</h1>
      <p>Click one of your classes to cancel it. Its students see it struck through on their timetable.</p>
      {picked && (
        <div className="cancel-panel">
          {picked.cancelled ? (
            <span>
              {picked.courseId} on {picked.day} {picked.startTime}–{picked.endTime} is already cancelled.
            </span>
          ) : (
            <>
              <span>
                Cancel <strong>{picked.courseId}</strong> on {picked.day} {picked.startTime}–{picked.endTime}
                {picked.section ? ` for Sec ${picked.section}` : ''}?
              </span>
              <button type="button" className="danger" disabled={cancelling} onClick={() => cancel(picked)}>
                {cancelling ? 'Cancelling...' : 'Cancel class'}
              </button>
            </>
          )}
          <button type="button" onClick={() => setPicked(null)} disabled={cancelling}>
            Close
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <TimetableGrid grid={grid} onBusyClick={(e) => { setError(''); setPicked(e) }} />
    </div>
  )
}
