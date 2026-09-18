import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, freeAcrossAll, type BusyEntry, type ChangeEntry, type Cell } from './lib/grid'
import type { Profile } from './lib/useMyProfile'
import { resolveSectionFromEmail } from './lib/rollLookup'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type SectionRef = { program: string; branch: string; section: string; semester: number; subSection?: string }

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

  return <MyTimetable section={profile.linkedSection as SectionRef} email={profile.email} />
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

function MyTimetable({ section, email }: { section: SectionRef; email: string }) {
  const [grid, setGrid] = useState<Cell[][] | null>(null)
  const [freeGrid, setFreeGrid] = useState<Cell[][] | null>(null)
  const [hasData, setHasData] = useState(true)
  const [showFree, setShowFree] = useState(false)
  const [groups, setGroups] = useState<{ section: string; subSection?: string; unknownSplit: string[] }>({
    section: section.section,
    unknownSplit: [],
  })

  useEffect(() => {
    // The linked profile may predate a B1/B2 upload, so re-resolve the
    // sub-section on every load. A profile linked by picking "B1" from
    // the list counts as section B + sub-section B1.
    const picked = /^[A-Z]\d$/i.test(section.section)
      ? { section: section.section[0], subSection: section.section }
      : { section: section.section, subSection: section.subSection }
    Promise.all([listTimetableSlots(), listScheduleChanges(), resolveSectionFromEmail(email)]).then(
      ([slots, changes, resolved]) => {
        const subSection =
          picked.subSection ??
          (resolved && resolved.section === picked.section && resolved.semester === section.semester
            ? resolved.subSection
            : undefined)
        const mine = (s: string) => s === picked.section || (subSection !== undefined && s === subSection)
        const batch = slots.data.filter(
          (r) => r.program === section.program && r.branch === section.branch && r.semester === section.semester,
        )
        const mySlots = batch.filter((r) => mine(r.section))
        const unknownSplit = subSection
          ? []
          : [...new Set(batch.map((r) => r.section).filter((s) => s.length === 2 && s[0] === picked.section))].sort()
        const myChanges = changes.data.filter(
          (r) => r.program === section.program && r.branch === section.branch && mine(r.section),
        )
        setGroups({ section: picked.section, subSection, unknownSplit })
        setHasData(mySlots.length > 0)
        setGrid(buildGrid(mySlots, myChanges))
        setFreeGrid(freeAcrossAll([mySlots]))
      },
    )
  }, [section, email])

  if (!grid) return <p>Loading your timetable...</p>

  return (
    <div className="dashboard">
      <h1>
        My Timetable — {section.program} {section.branch} Sem {section.semester} Sec{' '}
        {groups.subSection ?? groups.section}
      </h1>
      {groups.unknownSplit.length > 0 && (
        <p className="error">
          Section {groups.section} splits into {groups.unknownSplit.join('/')} for some classes, and we don't know
          your group yet, so those classes aren't shown. Your admin needs to upload the {groups.unknownSplit.join('/')}{' '}
          list.
        </p>
      )}
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
