import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, type BusyEntry, type Cell } from './lib/grid'
import type { Profile } from './lib/useMyProfile'

const client = generateClient<Schema>()

type TimetableSlotRow = BusyEntry & { faculty?: string | null }
const listTimetableSlots = client.models.TimetableSlot.list as unknown as () => Promise<{
  data: TimetableSlotRow[]
}>

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
  const [grid, setGrid] = useState<Cell[][] | null>(null)

  useEffect(() => {
    listTimetableSlots().then(({ data }) => {
      const mine = data.filter((r) => r.faculty === facultyName)
      setGrid(buildGrid(mine))
    })
  }, [facultyName])

  if (!grid) return <p>Loading your timetable...</p>

  return (
    <div className="dashboard">
      <h1>My Teaching Timetable — {facultyName}</h1>
      <TimetableGrid grid={grid} />
    </div>
  )
}
