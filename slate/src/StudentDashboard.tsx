import { useCallback, useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import {
  addDays,
  removes as removesChange,
  buildGrid,
  dateIn,
  DAYS,
  forWeek,
  formatDate,
  KIND_LABEL,
  mondayOf,
  personLabel,
  todayIst,
  type BusyEntry,
  type ChangeEntry,
} from './lib/grid'
import { addExtra, cancelOccurrence, claimCr, moveOccurrence, sectionKey, undoChange, type ClassRep } from './lib/classReps'
import { toActions, type Action } from './lib/changes'
import ActionLine from './components/ActionLine'
import type { Profile } from './lib/useMyProfile'
import { fetchMyTimetable, resolveSectionFromEmail, type MyTimetable } from './lib/rollLookup'

import { listAll } from './lib/listAll'

const client = generateClient<Schema>()

type SectionRef = { program: string; branch: string; section: string; semester: number; subSection?: string }

type TimetableSlotRow = BusyEntry & { program: string; branch: string; section: string; semester: number }
const listTimetableSlots = () => listAll<TimetableSlotRow>(client.models.TimetableSlot.list)
type ScheduleChangeRow = ChangeEntry & {
  offeringKey?: string | null
  meetingId?: string | null
  program?: string | null
  branch?: string | null
  semester?: number | null
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
  const [data, setData] = useState<{ me: MyTimetable; changes: ScheduleChangeRow[] } | null>(null)
  const [monday, setMonday] = useState(() => mondayOf(todayIst()))
  const groups = { section: section.section, subSection: section.subSection, unknownSplit: [] as string[] }
  const [panel, setPanel] = useState<Panel | null>(null)
  const [offeringKey, setOfferingKey] = useState('')
  const [room, setRoom] = useState('')
  // Shortening or shifting one occurrence: "10–12 runs 11–12 this week".
  const [retime, setRetime] = useState<{ start: string; end: string } | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)

  const load = useCallback(() => {
    // The server knows which offerings this student is registered in and
    // every meeting of those offerings (docs/DATA-MODEL.md); changes are
    // matched to the same offerings.
    return Promise.all([fetchMyTimetable(), listScheduleChanges()])
      .then(([me, changes]) => {
        if (!me) return setLoadError("Your roll number isn't in the uploaded student lists yet. Ask your admin.")
        const mine = new Set(me.offerings.map((o) => o.offeringKey))
        setData({ me, changes: changes.data.filter((c) => c.date && c.offeringKey && mine.has(c.offeringKey)) })
        setLoadError('')
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const failed = loadError ? `Couldn't load your timetable: ${loadError}` : !reps ? repsError : ''
  if (failed) return <p className="error">{failed}</p>
  if (!data || !reps) return <p>Loading your timetable...</p>

  const today = todayIst()
  const me = data.me
  const busy: BusyEntry[] = me.meetings.map((m) => ({
    id: m.id,
    day: m.day,
    startTime: m.startTime,
    endTime: m.endTime,
    courseId: m.courseId,
    room: m.room,
    faculty: m.faculty,
    section: m.section,
    sessionType: m.sessionType,
  }))
  // Registered, but the timetable sheets never say when it meets (the HSS
  // electives are scheduled outside the departmental sheet).
  const withoutTimes = me.offerings.filter((o) => !me.meetings.some((m) => m.offeringKey === o.offeringKey))
  const key = sectionKey(section)
  const rep = reps.find((r) => r.sectionKey === key)
  const isCr = rep?.sub === userId
  const week = forWeek(data.changes, monday)
  const grid = buildGrid(busy, week)
  const dayLabels = Object.fromEntries(DAYS.map((d) => [d, formatDate(dateIn(monday, d))]))

  // Courses this CR can act for: every course their section takes.
  // A CR acts for the offerings they attend.
  const myOfferings = [...me.offerings].sort((a, b) => a.courseCode.localeCompare(b.courseCode))
  const offeringLabel = (o: (typeof me.offerings)[number]) =>
    `${o.courseCode}${o.faculty ? ` · ${o.faculty}` : ''}${o.sections.length ? ` · Sec ${o.sections.join(', ')}` : ''}`

  // Only this week and next matter (older changes are deleted by the
  // table's TTL). One line per action: a change for B and B1, or both
  // halves of a move, is one action. New = made by someone else since the
  // student last marked the list seen.
  const thisMonday = mondayOf(today)
  const nextMonday = addDays(thisMonday, 7)
  const actions = toActions(data.changes).filter((x) => x.date >= thisMonday && x.date <= addDays(nextMonday, 5))
  const isNew = (x: Action) => !x.undone && x.changedBy !== email && (!seenAt || x.createdAt > seenAt)
  const newCount = actions.filter(isNew).length
  const shown = onlyMine ? actions.filter((x) => x.changedBy === email) : actions

  const act = async (fn: () => Promise<void>) => {
    setWorking(true)
    setError('')
    try {
      await fn()
      await Promise.all([load(), reloadReps()])
      setPanel(null)
      setRoom('')
      setRetime(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setWorking(false)
    }
  }
  const open = (p: Panel, date: string) => {
    setError('')
    setRetime(null)
    if (date < today) return setError(`${formatDate(date)} has already passed.`)
    setPanel(p)
    if (p.kind === 'add' && !myOfferings.some((o) => o.offeringKey === offeringKey)) setOfferingKey(myOfferings[0]?.offeringKey ?? '')
  }

  return (
    <div className="dashboard">
      <h1>
        My Timetable — {section.program} {section.branch} Sem {section.semester} Sec{' '}
        {groups.subSection ?? groups.section}
      </h1>
      <UpNext busy={busy} changes={data.changes} />

      <details className="my-courses">
        <summary>
          My courses ({me.offerings.length})
          {withoutTimes.length > 0 && ` · ${withoutTimes.length} with no class times yet`}
        </summary>
        <ul className="change-history">
          {[...me.offerings]
            .sort((x, y) => x.courseCode.localeCompare(y.courseCode))
            .map((o) => {
              const times = me.meetings.filter((m) => m.offeringKey === o.offeringKey).length
              return (
                <li key={o.offeringKey}>
                  <span className={`kind ${o.kind && o.kind !== 'CORE' ? 'added' : 'cancelled'}`}>
                    {(o.kind ?? 'CORE').replace('_', ' ').toLowerCase()}
                  </span>
                  <span>
                    <strong>{o.courseCode}</strong>
                    {o.courseName ? ` — ${o.courseName}` : ''}
                    {o.faculty ? ` · ${o.faculty}` : ''}
                  </span>
                  <span className="meta">
                    {times > 0
                      ? `${times} class(es) a week${o.sections.length ? ` · Sec ${o.sections.join(', ')}` : ''}`
                      : 'class times not published — ask your CR'}
                  </span>
                </li>
              )
            })}
        </ul>
      </details>

      {me.meetings.length === 0 && (
        <p className="error">
          None of your courses has a timetable yet — your registrations are in, but the classes for them haven't been
          ingested.
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
                  <button type="button" disabled={working} onClick={() => act(() => undoChange(x.groupId))}>
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
            <button type="button" className="primary" disabled={working} onClick={() => act(claimCr)}>
              {working ? 'Claiming...' : 'Become CR'}
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
                if (!offeringKey) return setError('Pick a course.')
                act(() =>
                  addExtra({ offeringKey, date: panel.date, startTime: panel.start, endTime: panel.end, room: room.trim() || null }),
                )
              }}
            >
              <span>
                Extra class on <strong>{formatDate(panel.date)} {panel.start}–{panel.end}</strong>
              </span>
              <select value={offeringKey} onChange={(e) => setOfferingKey(e.target.value)}>
                {myOfferings.map((o) => (
                  <option key={o.offeringKey} value={o.offeringKey}>
                    {o.courseCode}
                    {o.courseName ? ` — ${o.courseName}` : ''}
                  </option>
                ))}
              </select>
              <input placeholder="Room (optional)" value={room} onChange={(e) => setRoom(e.target.value)} />
              <button type="submit" className="primary" disabled={working || !offeringKey}>
                {working ? 'Adding...' : 'Add extra class'}
              </button>
              {offeringKey && (
                <span className="meta">
                  For everyone registered in {offeringLabel(myOfferings.find((o) => o.offeringKey === offeringKey)!)}
                </span>
              )}
            </form>
          )}
          {panel.kind === 'class' && (
            <>
              <span>
                <strong>{panel.entry.courseId}</strong> · {formatDate(panel.date)} {panel.entry.startTime}–
                {panel.entry.endTime}
                {panel.entry.cancelled
                  ? ` · ${KIND_LABEL[panel.entry.cancelled.kind].toLowerCase()} by ${personLabel(panel.entry.cancelled.changedBy)}`
                  : ` · everyone registered in it${panel.entry.section ? ` (Sec ${panel.entry.section})` : ''}`}
              </span>
              {panel.entry.cancelled ? (
                <button type="button" disabled={working} onClick={() => act(() => undoChange(panel.entry.cancelled!.groupId!))}>
                  {working ? 'Undoing...' : 'Undo'}
                </button>
              ) : retime ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (retime.start >= retime.end) return setError('The class has to end after it starts.')
                    act(() =>
                      moveOccurrence({
                        meetingId: panel.entry.id!,
                        fromDate: panel.date,
                        date: panel.date,
                        startTime: retime.start,
                        endTime: retime.end,
                        room: room.trim() || null,
                      }),
                    )
                  }}
                >
                  <span>Runs from</span>
                  <input type="time" value={retime.start} onChange={(e) => setRetime({ ...retime, start: e.target.value })} />
                  <span>to</span>
                  <input type="time" value={retime.end} onChange={(e) => setRetime({ ...retime, end: e.target.value })} />
                  <input placeholder="Room (optional)" value={room} onChange={(e) => setRoom(e.target.value)} />
                  <button type="submit" className="primary" disabled={working}>
                    {working ? 'Saving...' : 'Save this time'}
                  </button>
                  <button type="button" disabled={working} onClick={() => setRetime(null)}>
                    Back
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setRetime({ start: panel.entry.startTime, end: panel.entry.endTime })}
                  >
                    Change the time
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={working}
                    onClick={() => act(() => cancelOccurrence(panel.entry.id!, panel.date))}
                  >
                    {working ? 'Cancelling...' : `Cancel on ${formatDate(panel.date)}`}
                  </button>
                </>
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
              <button type="button" className="danger" disabled={working} onClick={() => act(() => undoChange(panel.change.groupId!))}>
                {working ? 'Undoing...' : 'Undo'}
              </button>
            </>
          )}
          <button type="button" disabled={working} onClick={() => setPanel(null)}>
            Close
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <TimetableGrid
        grid={grid}
        today={monday === thisMonday ? DAYS[new Date(`${today}T00:00:00Z`).getUTCDay() - 1] : undefined}
        dayLabels={dayLabels}
        onEmptyClick={
          isCr ? (day, start, end) => open({ kind: 'add', date: dateIn(monday, day), start, end }, dateIn(monday, day)) : undefined
        }
        onBusyClick={
          isCr ? (entry) => open({ kind: 'class', entry, date: dateIn(monday, entry.day) }, dateIn(monday, entry.day)) : undefined
        }
        onChangeClick={isCr ? (change) => open({ kind: 'change', change }, change.date) : undefined}
      />

    </div>
  )
}


/** What a student opens the app to find out: the class they're in, the one
 * coming, or -- on a Sunday or after the last class -- the next one there
 * is. Cancelled classes are skipped, because the point is where to be. */
function UpNext({ busy, changes }: { busy: BusyEntry[]; changes: ScheduleChangeRow[] }) {
  const today = todayIst()
  const now = new Date(Date.now() + 5.5 * 3600e3)
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  const at = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
  const dayOf = (date: string) => DAYS[new Date(`${date}T00:00:00Z`).getUTCDay() - 1]

  /** Every class actually happening on a date: the week's classes minus
   * that date's cancellations, plus its extra classes. */
  const classesOn = (date: string) => {
    const day = dayOf(date)
    if (!day) return []
    const dated = forWeek(changes, mondayOf(date)).filter((c) => c.date === date)
    const grid = buildGrid(busy, dated)
    const regular = grid[DAYS.indexOf(day)].flatMap((cell) =>
      cell.busy.filter((b) => !b.cancelled).map((b) => ({ start: b.startTime, end: b.endTime, what: b.courseId, where: b.room ?? null })),
    )
    const extra = dated
      .filter((c) => !removesChange(c.kind))
      .map((c) => ({ start: c.startTime, end: c.endTime, what: c.courseId, where: c.room ?? null }))
    return [...regular, ...extra]
      .reduce(
        (seen, c) => (seen.some((x) => x.start === c.start && x.what === c.what) ? seen : [...seen, c]),
        [] as { start: string; end: string; what: string; where: string | null }[],
      )
      .sort((a, b) => a.start.localeCompare(b.start))
  }

  const todays = classesOn(today)
  const current = todays.find((c) => mins >= at(c.start) && mins < at(c.end))
  const next = todays.find((c) => at(c.start) > mins)

  // Nothing left today: look ahead for the next class there is.
  let ahead: { date: string; klass: (typeof todays)[number] } | null = null
  if (!current && !next)
    for (let i = 1; i <= 7 && !ahead; i++) {
      const date = addDays(today, i)
      const first = classesOn(date)[0]
      if (first) ahead = { date, klass: first }
    }

  const until = next ? at(next.start) - mins : 0
  const countdown = until >= 60 ? `in ${Math.floor(until / 60)} h ${until % 60} min` : `in ${until} min`
  const when = current ? 'In class now' : next ? 'Up next' : ahead ? 'Next class' : 'Nothing scheduled'
  const what = current?.what ?? next?.what ?? ahead?.klass.what ?? 'Enjoy the break'
  const where = current
    ? `until ${current.end}${current.where ? ` · ${current.where}` : ''}`
    : next
      ? `${next.start}–${next.end}${next.where ? ` · ${next.where}` : ''}`
      : ahead
        ? `${formatDate(ahead.date)} · ${ahead.klass.start}–${ahead.klass.end}${ahead.klass.where ? ` · ${ahead.klass.where}` : ''}`
        : 'No classes on your timetable in the next week'

  return (
    <section className={`up-next${current || next ? '' : ' is-free'}`}>
      <div className="up-next-main">
        <div className="when">{when}</div>
        <div className="what">{what}</div>
        <div className="where">{where}</div>
      </div>
      {!current && next && <div className="countdown">{countdown}</div>}
    </section>
  )
}
