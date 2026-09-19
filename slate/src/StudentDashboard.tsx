import { useCallback, useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import {
  addDays,
  buildGrid,
  dateIn,
  DAYS,
  forWeek,
  formatDate,
  freeAcrossAll,
  KIND_LABEL,
  mondayOf,
  personLabel,
  todayIst,
  type BusyEntry,
  type ChangeEntry,
} from './lib/grid'
import { addExtra, cancelOccurrence, claimCr, sectionKey, undoChange, type ClassRep } from './lib/classReps'
import { toActions, type Action } from './lib/changes'
import ActionLine from './components/ActionLine'
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
  semester: number
  createdAt: string
}
const listScheduleChanges = () => listAll<ScheduleChangeRow>(client.models.ScheduleChange.list)

type RepProps = {
  userId: string
  reps: ClassRep[] | null
  reloadReps: () => Promise<void>
  repsError?: string
  /** "What changed" feed: when the student last marked it seen. */
  seenAt: string | null
  markSeen: () => Promise<void>
}

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
  | { kind: 'add'; date: string; start: string; end: string }
  | { kind: 'class'; entry: BusyEntry; date: string }
  | { kind: 'change'; change: ChangeEntry }

/** B covers B1/B2 (same rule as the server's reach()). */
function reach(sections: string[]): string[] {
  const set = new Set(sections)
  return [...set].filter((s) => !(s.length === 2 && set.has(s[0]))).sort()
}

function MyTimetable({
  section,
  email,
  userId,
  reps,
  reloadReps,
  repsError,
  seenAt,
  markSeen,
}: { section: SectionRef; email: string } & RepProps) {
  const [data, setData] = useState<{ batch: TimetableSlotRow[]; slots: TimetableSlotRow[]; changes: ScheduleChangeRow[] } | null>(null)
  const [monday, setMonday] = useState(() => mondayOf(todayIst()))
  const [showFree, setShowFree] = useState(false)
  const [groups, setGroups] = useState<{ section: string; subSection?: string; unknownSplit: string[] }>({
    section: section.section,
    unknownSplit: [],
  })
  const [panel, setPanel] = useState<Panel | null>(null)
  const [courseId, setCourseId] = useState('')
  const [room, setRoom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)

  const load = useCallback(() => {
    // The linked profile may predate a B1/B2 upload, so re-resolve the
    // sub-section on every load. A profile linked by picking "B1" from
    // the list counts as section B + sub-section B1.
    const picked = /^[A-Z]\d$/i.test(section.section)
      ? { section: section.section[0], subSection: section.section }
      : { section: section.section, subSection: section.subSection }
    return Promise.all([listTimetableSlots(), listScheduleChanges(), resolveSectionFromEmail(email)])
      .then(([slots, changes, resolved]) => {
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
          batch,
          slots: batch.filter((r) => mine(r.section)),
          changes: changes.data.filter(
            (r) =>
              r.date &&
              r.program === section.program &&
              r.branch === section.branch &&
              r.semester === section.semester &&
              mine(r.section),
          ),
        })
        setLoadError('')
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [section, email])

  useEffect(() => {
    load()
  }, [load])

  const failed = loadError ? `Couldn't load your timetable: ${loadError}` : !reps ? repsError : ''
  if (failed) return <p className="error">{failed}</p>
  if (!data || !reps) return <p>Loading your timetable...</p>

  const today = todayIst()
  const key = sectionKey(section)
  const rep = reps.find((r) => r.sectionKey === key)
  const isCr = rep?.sub === userId
  const week = forWeek(data.changes, monday)
  const grid = buildGrid(data.slots, week)
  const dayLabels = Object.fromEntries(DAYS.map((d) => [d, formatDate(dateIn(monday, d))]))

  // Courses this CR can act for: every course their section takes.
  const myCourses = [...new Set(data.slots.map((r) => r.courseId))].sort()
  // Sections a change to `course` reaches: the ones taught by the same
  // professor as this section (same rule as the server).
  const sectionsOf = (course: string) => {
    const rows = data.batch.filter((r) => r.courseId === course && r.section !== '*')
    const profs = new Set(rows.filter((r) => r.section[0] === groups.section && r.faculty).map((r) => r.faculty))
    return reach(rows.filter((r) => !profs.size || profs.has(r.faculty)).map((r) => r.section))
  }

  // Only this week and next matter (older changes are deleted by the
  // table's TTL). One line per action: a change for B and B1, or both
  // halves of a move, is one action. New = made by someone else since the
  // student last marked the list seen.
  const thisMonday = mondayOf(today)
  const nextMonday = addDays(thisMonday, 7)
  const actions = toActions(data.changes).filter((x) => x.date >= thisMonday && x.date <= addDays(nextMonday, 4))
  const isNew = (x: Action) => !x.undone && x.changedBy !== email && (!seenAt || x.createdAt > seenAt)
  const newCount = actions.filter(isNew).length
  const shown = onlyMine ? actions.filter((x) => x.changedBy === email) : actions

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await Promise.all([load(), reloadReps()])
      setPanel(null)
      setRoom('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }
  const open = (p: Panel, date: string) => {
    setError('')
    if (date < today) return setError(`${formatDate(date)} has already passed.`)
    setPanel(p)
    if (p.kind === 'add' && !myCourses.includes(courseId)) setCourseId(myCourses[0] ?? '')
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

      <section className="feed">
        <div className="feed-head">
          <h2>What changed this week and next{newCount ? ` · ${newCount} new` : ''}</h2>
          {newCount > 0 && (
            <button type="button" onClick={() => markSeen()}>
              Mark as seen
            </button>
          )}
          {isCr && actions.length > 0 && (
            <label className="day-toggle">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              Only ones I made
            </label>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="meta">
            {onlyMine ? "You haven't made any changes for these two weeks." : 'No changes. Your regular timetable holds.'}
          </p>
        ) : (
          <ul className="change-history">
            {shown.map((x) => (
              <ActionLine key={x.groupId} action={x} isNew={isNew(x)}>
                {isCr && !x.undone && x.date >= today && (
                  <button type="button" disabled={busy} onClick={() => act(() => undoChange(x.groupId))}>
                    Undo
                  </button>
                )}
              </ActionLine>
            ))}
          </ul>
        )}
      </section>

      <div className={`cr-bar${isCr ? ' is-cr' : ''}`}>
        {isCr ? (
          <span>
            <strong>You're the CR for Sec {groups.section}.</strong> Click a free hour to add an extra class, or a
            class to cancel it. A change reaches every section taking that course, with your name on it.
          </span>
        ) : rep ? (
          <span>
            CR for Sec {groups.section}: <strong>{personLabel(rep.email)}</strong> since{' '}
            {new Date(rep.createdAt).toLocaleDateString()}. Changes to your timetable come from your batch's CRs.
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

      <div className="week-nav option-list">
        <button type="button" className={monday === thisMonday ? 'active' : ''} onClick={() => setMonday(thisMonday)}>
          This week · {formatDate(thisMonday)}
        </button>
        <button type="button" className={monday === nextMonday ? 'active' : ''} onClick={() => setMonday(nextMonday)}>
          Next week · {formatDate(nextMonday)}
        </button>
      </div>

      {panel && (
        <div className="cr-panel">
          {panel.kind === 'add' && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!courseId) return setError('Pick a course.')
                act(() =>
                  addExtra({ courseId, date: panel.date, startTime: panel.start, endTime: panel.end, room: room.trim() || null }),
                )
              }}
            >
              <span>
                Extra class on <strong>{formatDate(panel.date)} {panel.start}–{panel.end}</strong>
              </span>
              <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                {myCourses.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input placeholder="Room (optional)" value={room} onChange={(e) => setRoom(e.target.value)} />
              <button type="submit" className="primary" disabled={busy || !courseId}>
                {busy ? 'Adding...' : 'Add extra class'}
              </button>
              {courseId && <span className="meta">For Sec {sectionsOf(courseId).join(', ')}</span>}
            </form>
          )}
          {panel.kind === 'class' && (
            <>
              <span>
                <strong>{panel.entry.courseId}</strong> · {formatDate(panel.date)} {panel.entry.startTime}–
                {panel.entry.endTime}
                {panel.entry.cancelled
                  ? ` · ${KIND_LABEL[panel.entry.cancelled.kind].toLowerCase()} by ${personLabel(panel.entry.cancelled.changedBy)}`
                  : ` · Sec ${panel.entry.section}`}
              </span>
              {panel.entry.cancelled ? (
                <button type="button" disabled={busy} onClick={() => act(() => undoChange(panel.entry.cancelled!.groupId!))}>
                  {busy ? 'Undoing...' : 'Undo'}
                </button>
              ) : (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => act(() => cancelOccurrence(panel.entry.mergedIds?.[0] ?? panel.entry.id!, panel.date))}
                >
                  {busy ? 'Cancelling...' : `Cancel on ${formatDate(panel.date)}`}
                </button>
              )}
            </>
          )}
          {panel.kind === 'change' && (
            <>
              <span>
                <strong>{panel.change.courseId}</strong> · {formatDate(panel.change.date)} {panel.change.startTime}–
                {panel.change.endTime} · {KIND_LABEL[panel.change.kind].toLowerCase()} by{' '}
                {personLabel(panel.change.changedBy)}
              </span>
              <button type="button" className="danger" disabled={busy} onClick={() => act(() => undoChange(panel.change.groupId!))}>
                {busy ? 'Undoing...' : 'Undo'}
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
        {showFree ? 'Show my classes' : 'Show free hours for my class'}
      </button>
      <TimetableGrid
        grid={showFree ? freeAcrossAll([data.slots]) : grid}
        freeIsHighlighted={showFree}
        dayLabels={dayLabels}
        onEmptyClick={
          isCr ? (day, start, end) => open({ kind: 'add', date: dateIn(monday, day), start, end }, dateIn(monday, day)) : undefined
        }
        onBusyClick={
          isCr && !showFree ? (entry) => open({ kind: 'class', entry, date: dateIn(monday, entry.day) }, dateIn(monday, entry.day)) : undefined
        }
        onChangeClick={isCr && !showFree ? (change) => open({ kind: 'change', change }, change.date) : undefined}
      />

    </div>
  )
}

