import { useCallback, useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, freeAcrossAll, personLabel, type BusyEntry, type ChangeEntry } from './lib/grid'
import { addClass, cancelClass, claimCr, sectionKey, undoChange, type ClassRep } from './lib/classReps'
import type { Profile } from './lib/useMyProfile'
import { resolveSectionFromEmail } from './lib/rollLookup'
import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type SectionRef = { program: string; branch: string; section: string; semester: number; subSection?: string }

type TimetableSlotRow = BusyEntry & { program: string; branch: string; section: string; semester: number }
const listTimetableSlots = () => listAll<TimetableSlotRow>(client.models.TimetableSlot.list)
type ScheduleChangeRow = ChangeEntry & {
  program: string
  branch: string
  section: string
  semester?: number | null
  createdAt: string
  undoneBy?: string | null
}
const listScheduleChanges = () => listAll<ScheduleChangeRow>(client.models.ScheduleChange.list)

type RepProps = { userId: string; reps: ClassRep[] | null; reloadReps: () => Promise<void> }

export default function StudentDashboard({
  profile,
  linkSection,
  ...repProps
}: {
  profile: Profile
  linkSection: (section: SectionRef) => Promise<void>
} & RepProps) {
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

  return <MyTimetable section={profile.linkedSection as SectionRef} email={profile.email} {...repProps} />
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

type Panel =
  | { kind: 'add'; day: string; start: string; end: string }
  | { kind: 'class'; entry: BusyEntry }
  | { kind: 'added'; change: ChangeEntry }

function MyTimetable({
  section,
  email,
  userId,
  reps,
  reloadReps,
}: { section: SectionRef; email: string } & RepProps) {
  const [data, setData] = useState<{ slots: TimetableSlotRow[]; changes: ScheduleChangeRow[] } | null>(null)
  const [showFree, setShowFree] = useState(false)
  const [groups, setGroups] = useState<{ section: string; subSection?: string; unknownSplit: string[] }>({
    section: section.section,
    unknownSplit: [],
  })
  const [panel, setPanel] = useState<Panel | null>(null)
  const [purpose, setPurpose] = useState('')
  const [room, setRoom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    // The linked profile may predate a B1/B2 upload, so re-resolve the
    // sub-section on every load. A profile linked by picking "B1" from
    // the list counts as section B + sub-section B1.
    const picked = /^[A-Z]\d$/i.test(section.section)
      ? { section: section.section[0], subSection: section.section }
      : { section: section.section, subSection: section.subSection }
    return Promise.all([listTimetableSlots(), listScheduleChanges(), resolveSectionFromEmail(email)]).then(
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
        const unknownSplit = subSection
          ? []
          : [...new Set(batch.map((r) => r.section).filter((s) => s.length === 2 && s[0] === picked.section))].sort()
        setGroups({ section: picked.section, subSection, unknownSplit })
        setData({
          slots: batch.filter((r) => mine(r.section)),
          changes: changes.data.filter(
            (r) =>
              r.program === section.program &&
              r.branch === section.branch &&
              (r.semester == null || r.semester === section.semester) &&
              mine(r.section),
          ),
        })
      },
    )
  }, [section, email])

  useEffect(() => {
    load()
  }, [load])

  if (!data || !reps) return <p>Loading your timetable...</p>

  const key = sectionKey(section)
  const rep = reps.find((r) => r.sectionKey === key)
  const isCr = rep?.sub === userId
  const grid = buildGrid(data.slots, data.changes)
  const history = [...data.changes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await Promise.all([load(), reloadReps()])
      setPanel(null)
      setPurpose('')
      setRoom('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }
  const open = (p: Panel) => {
    setError('')
    setPanel(p)
  }

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
      {data.slots.length === 0 && (
        <p className="error">
          No timetable has been ingested for this section yet — the identity link worked
          correctly, but this particular section's data hasn't been loaded into the system.
        </p>
      )}

      <div className={`cr-bar${isCr ? ' is-cr' : ''}`}>
        {isCr ? (
          <span>
            <strong>You're the CR for Sec {groups.section}.</strong> Click a free hour to add a class, or a class to
            cancel it. Every change shows your name.
          </span>
        ) : rep ? (
          <span>
            CR for Sec {groups.section}: <strong>{personLabel(rep.email)}</strong> · only they can change this
            timetable.
          </span>
        ) : (
          <>
            <span>Sec {groups.section} has no CR yet. The CR is the one student who keeps this timetable up to date.</span>
            <button type="button" className="primary" disabled={busy} onClick={() => act(claimCr)}>
              {busy ? 'Claiming...' : 'Become CR'}
            </button>
          </>
        )}
      </div>

      {panel && (
        <div className="cr-panel">
          {panel.kind === 'add' && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!purpose.trim()) return setError('Say what the class is for.')
                act(() =>
                  addClass({ day: panel.day, startTime: panel.start, endTime: panel.end, room: room.trim() || null, purpose: purpose.trim() }),
                )
              }}
            >
              <span>
                Add a class on <strong>{panel.day} {panel.start}–{panel.end}</strong>
              </span>
              <input autoFocus placeholder="What for? e.g. IML makeup class" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              <input placeholder="Room (optional)" value={room} onChange={(e) => setRoom(e.target.value)} />
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Adding...' : 'Add class'}
              </button>
            </form>
          )}
          {panel.kind === 'class' && (
            <>
              <span>
                <strong>{panel.entry.courseId}</strong> · {panel.entry.day} {panel.entry.startTime}–{panel.entry.endTime}
                {panel.entry.cancelled ? ` · cancelled by ${personLabel(panel.entry.cancelled.changedBy)}` : ''}
              </span>
              {panel.entry.cancelled ? (
                <button type="button" disabled={busy} onClick={() => act(() => undoChange(panel.entry.cancelled!.id!))}>
                  {busy ? 'Restoring...' : 'Restore class'}
                </button>
              ) : (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => act(() => cancelClass(panel.entry.mergedIds ?? [panel.entry.id!]))}
                >
                  {busy ? 'Cancelling...' : 'Cancel class'}
                </button>
              )}
            </>
          )}
          {panel.kind === 'added' && (
            <>
              <span>
                <strong>{panel.change.courseId}</strong> · {panel.change.day} {panel.change.startTime}–{panel.change.endTime} ·
                added by {personLabel(panel.change.changedBy)}
              </span>
              <button type="button" className="danger" disabled={busy} onClick={() => act(() => undoChange(panel.change.id!))}>
                {busy ? 'Removing...' : 'Remove this class'}
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={() => setPanel(null)}>
            Close
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <button type="button" onClick={() => setShowFree((v) => !v)}>
        {showFree ? 'Show my classes' : 'Show free slots for my class'}
      </button>
      <TimetableGrid
        grid={showFree ? freeAcrossAll([data.slots]) : grid}
        freeIsHighlighted={showFree}
        onEmptyClick={isCr ? (day, start, end) => open({ kind: 'add', day, start, end }) : undefined}
        onBusyClick={isCr && !showFree ? (entry) => open({ kind: 'class', entry }) : undefined}
        onChangeClick={isCr && !showFree ? (change) => open({ kind: 'added', change }) : undefined}
      />

      <h2>Change history</h2>
      {history.length === 0 ? (
        <p className="meta">No changes yet. Anything the CR adds or cancels shows up here with their name.</p>
      ) : (
        <ul className="change-history">
          {history.map((c) => (
            <li key={c.id} className={c.undoneAt ? 'undone' : ''}>
              <span className={`kind ${c.changeType === 'SCHEDULED' ? 'added' : 'cancelled'}`}>
                {c.changeType === 'SCHEDULED' ? 'Added' : 'Cancelled'}
              </span>
              <span>
                <strong>{c.courseId}</strong> · {c.day} {c.startTime}–{c.endTime}
                {c.room ? ` · ${c.room}` : ''}
              </span>
              <span className="meta">
                by {personLabel(c.changedBy)} · {new Date(c.createdAt).toLocaleString()}
                {c.undoneAt && ` · undone by ${personLabel(c.undoneBy)} ${new Date(c.undoneAt).toLocaleString()}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
