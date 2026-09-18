import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, freeAcrossAll, type BusyEntry, type ChangeEntry, type Cell } from './lib/grid'
import type { Profile } from './lib/useMyProfile'
import { resolveSectionFromEmail } from './lib/rollLookup'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type SectionRef = { program: string; branch: string; section: string; semester: number }

type TimetableSlotRow = BusyEntry & { program: string; branch: string; section: string; semester: number }
const listTimetableSlots = () => listAll<TimetableSlotRow>(client.models.TimetableSlot.list)
type ScheduleChangeRow = ChangeEntry & { program: string; branch: string; section: string }
const listScheduleChanges = () => listAll<ScheduleChangeRow>(client.models.ScheduleChange.list)

export default function StudentDashboard({
  profile,
  linkSection,
}: {
  profile: Profile
  linkSection: (section: SectionRef) => Promise<void>
}) {
  const [autoResolving, setAutoResolving] = useState(!profile.linkedSection)
  const [linkError, setLinkError] = useState('')

  useEffect(() => {
    if (profile.linkedSection) {
      setAutoResolving(false)
      return
    }
    let cancelled = false
    // Try the real roll-number->section mapping first (CLAUDE.md §4a);
    // only fall back to asking the student if nothing matches.
    resolveSectionFromEmail(profile.email)
      .then((resolved) => {
        if (cancelled) return
        if (resolved) {
          return linkSection(resolved).catch((err) =>
            setLinkError(err instanceof Error ? err.message : String(err)),
          )
        }
      })
      .finally(() => {
        if (!cancelled) setAutoResolving(false)
      })
    return () => {
      cancelled = true
    }
  }, [profile.email, profile.linkedSection])

  if (autoResolving) return <p>Loading...</p>
  if (!profile.linkedSection) {
    return (
      <>
        {linkError && (
          <p className="error">Automatic section detection failed: {linkError}</p>
        )}
        <SectionPicker onPick={linkSection} />
      </>
    )
  }

  return <MyTimetable section={profile.linkedSection as SectionRef} />
}

function SectionPicker({ onPick }: { onPick: (section: SectionRef) => void }) {
  const [options, setOptions] = useState<SectionRef[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listTimetableSlots().then(({ data }) => {
      const seen = new Set<string>()
      const opts: SectionRef[] = []
      for (const row of data) {
        const key = `${row.program}|${row.branch}|${row.section}|${row.semester}`
        if (!seen.has(key)) {
          seen.add(key)
          opts.push({
            program: row.program,
            branch: row.branch,
            section: row.section,
            semester: row.semester,
          })
        }
      }
      opts.sort((a, b) => a.semester - b.semester || a.section.localeCompare(b.section))
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
            key={`${opt.program}-${opt.branch}-${opt.section}-${opt.semester}`}
            type="button"
            onClick={() => onPick(opt)}
          >
            {opt.program} {opt.branch} Sem {opt.semester} — Sec {opt.section}
          </button>
        ))}
      </div>
    </div>
  )
}

function MyTimetable({ section }: { section: SectionRef }) {
  const [grid, setGrid] = useState<Cell[][] | null>(null)
  const [freeGrid, setFreeGrid] = useState<Cell[][] | null>(null)
  const [hasData, setHasData] = useState(true)
  const [showFree, setShowFree] = useState(false)

  useEffect(() => {
    Promise.all([listTimetableSlots(), listScheduleChanges()]).then(([slots, changes]) => {
      const mySlots = slots.data.filter(
        (r) =>
          r.program === section.program &&
          r.branch === section.branch &&
          r.section === section.section &&
          r.semester === section.semester,
      )
      const myChanges = changes.data.filter(
        (r) =>
          r.program === section.program &&
          r.branch === section.branch &&
          r.section === section.section,
      )
      setHasData(mySlots.length > 0)
      setGrid(buildGrid(mySlots, myChanges))
      setFreeGrid(freeAcrossAll([mySlots]))
    })
  }, [section])

  if (!grid) return <p>Loading your timetable...</p>

  return (
    <div className="dashboard">
      <h1>
        My Timetable — {section.program} {section.branch} Sem {section.semester} Sec{' '}
        {section.section}
      </h1>
      {!hasData && (
        <p className="error">
          No timetable has been ingested for this section yet — the identity link worked
          correctly, but this particular section's data hasn't been loaded into the system.
        </p>
      )}
      <button type="button" onClick={() => setShowFree((v) => !v)}>
        {showFree ? 'Show my classes' : 'Show free slots for my class'}
      </button>
      <TimetableGrid grid={showFree ? freeGrid! : grid} freeIsHighlighted={showFree} />
    </div>
  )
}
