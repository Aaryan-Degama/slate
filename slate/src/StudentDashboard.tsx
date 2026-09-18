import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, freeAcrossAll, type BusyEntry, type ChangeEntry, type Cell } from './lib/grid'
import { useMyProfile } from './lib/useMyProfile'

const client = generateClient<Schema>()

type TimetableSlotRow = BusyEntry & { program: string; branch: string; section: string }
const listTimetableSlots = client.models.TimetableSlot.list as unknown as () => Promise<{
  data: TimetableSlotRow[]
}>
type ScheduleChangeRow = ChangeEntry & { program: string; branch: string; section: string }
const listScheduleChanges = client.models.ScheduleChange.list as unknown as () => Promise<{
  data: ScheduleChangeRow[]
}>

export default function StudentDashboard() {
  const { profile, loading, linkSection } = useMyProfile()

  if (loading) return <p>Loading...</p>
  if (!profile) return <p>Could not load your profile.</p>
  if (!profile.linkedSection) return <SectionPicker onPick={linkSection} />

  return <MyTimetable section={profile.linkedSection} />
}

function SectionPicker({
  onPick,
}: {
  onPick: (section: { program: string; branch: string; section: string }) => void
}) {
  const [options, setOptions] = useState<{ program: string; branch: string; section: string }[]>(
    [],
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listTimetableSlots().then(({ data }) => {
      const seen = new Set<string>()
      const opts: typeof options = []
      for (const row of data) {
        const key = `${row.program}|${row.branch}|${row.section}`
        if (!seen.has(key)) {
          seen.add(key)
          opts.push({ program: row.program, branch: row.branch, section: row.section })
        }
      }
      opts.sort((a, b) => a.section.localeCompare(b.section))
      setOptions(opts)
      setLoading(false)
    })
  }, [])

  if (loading) return <p>Loading sections...</p>

  return (
    <div className="identity-link">
      <h1>Which section are you in?</h1>
      <p>Not set. Pick your real section — this links your login, it doesn't create any data.</p>
      <div className="option-list">
        {options.map((opt) => (
          <button
            key={`${opt.program}-${opt.branch}-${opt.section}`}
            type="button"
            onClick={() => onPick(opt)}
          >
            {opt.program} {opt.branch} — Sec {opt.section}
          </button>
        ))}
      </div>
    </div>
  )
}

function MyTimetable({
  section,
}: {
  section: { program: string; branch: string; section: string }
}) {
  const [grid, setGrid] = useState<Cell[][] | null>(null)
  const [freeGrid, setFreeGrid] = useState<Cell[][] | null>(null)
  const [showFree, setShowFree] = useState(false)

  useEffect(() => {
    Promise.all([listTimetableSlots(), listScheduleChanges()]).then(([slots, changes]) => {
      const mySlots = slots.data.filter(
        (r) =>
          r.program === section.program &&
          r.branch === section.branch &&
          r.section === section.section,
      )
      const myChanges = changes.data.filter(
        (r) =>
          r.program === section.program &&
          r.branch === section.branch &&
          r.section === section.section,
      )
      setGrid(buildGrid(mySlots, myChanges))
      setFreeGrid(freeAcrossAll([mySlots]))
    })
  }, [section])

  if (!grid) return <p>Loading your timetable...</p>

  return (
    <div className="dashboard">
      <h1>
        My Timetable — {section.program} {section.branch} Sec {section.section}
      </h1>
      <button type="button" onClick={() => setShowFree((v) => !v)}>
        {showFree ? 'Show my classes' : 'Show free slots for my class'}
      </button>
      <TimetableGrid grid={showFree ? freeGrid! : grid} freeIsHighlighted={showFree} />
    </div>
  )
}
