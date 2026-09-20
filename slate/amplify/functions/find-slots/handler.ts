// Slot finding (CLAUDE.md §5, docs/DATA-MODEL.md). A class belongs to an
// *offering*; the people who must be free are the students registered in
// it, plus the professor who teaches it.
//
// For each candidate date we build everyone's effective timetable -- their
// offerings' meetings that weekday, minus that date's cancellations, plus
// that date's extra classes -- intersect the free intervals, filter by the
// constraints, rank with simple explainable rules, attach a free room, and
// when nothing is free say who blocks it and with what.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { HOURS } from '../../../src/lib/grid'

type Args = {
  offeringKey: string
  dates: string[] // YYYY-MM-DD
  ignoreMeetingId?: string | null // a move: the class being moved doesn't block itself
  earliestTime?: string | null
  latestTime?: string | null
  minDurationMins?: number | null
}
type Row = Record<string, unknown>
type Busy = { date: string; start: string; end: string; room?: string; label: string }
type Candidate = { date: string; day: string; start: string; end: string }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const T = (k: string) => process.env[k]!
const [OF, ME, RG, SC, ST] = ['OFFERING_TABLE', 'CLASS_MEETING_TABLE', 'REGISTRATION_TABLE', 'SCHEDULE_CHANGE_TABLE', 'STUDENT_SECTION_TABLE'].map(T)

async function scanAll(table: string): Promise<Row[]> {
  const items: Row[] = []
  let start: Record<string, unknown> | undefined
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }))
    items.push(...((page.Items ?? []) as Row[]))
    start = page.LastEvaluatedKey
  } while (start)
  return items
}

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const weekdayOf = (date: string) => DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()]
const pretty = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`)
  const w = weekdayOf(date)
  return `${w[0]}${w.slice(1).toLowerCase()} ${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`
}
const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE
const removes = (k: unknown) => k === 'CANCELLED' || k === 'MOVED_FROM'

/** Every run of `n` consecutive, gap-free class hours on each date. */
function candidates(n: number, dates: string[], earliest: string, latest: string): Candidate[] {
  const out: Candidate[] = []
  for (const date of dates) {
    const day = weekdayOf(date)
    if (day === 'SUN') continue
    for (let i = 0; i + n <= HOURS.length; i++) {
      const hours = Array.from({ length: n }, (_, k) => i + k)
      if (hours.some((h, k) => k > 0 && HOURS[h].start !== HOURS[h - 1].end)) continue
      const [start, end] = [HOURS[hours[0]].start, HOURS[hours[n - 1]].end]
      if (start < earliest || end > latest) continue
      out.push({ date, day, start, end })
    }
  }
  return out
}

export const handler = async (event: { arguments: Args }) => {
  const a = event.arguments
  const dates = [...new Set((a.dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))].sort()
  if (!a.offeringKey) throw new Error('Pick a class.')
  if (!dates.length) throw new Error('Pick at least one date.')

  const [offerings, meetings, regs, changes, students] = await Promise.all([
    scanAll(OF),
    scanAll(ME),
    scanAll(RG),
    scanAll(SC),
    scanAll(ST),
  ])
  const offering = offerings.find((o) => o.offeringKey === a.offeringKey)
  if (!offering) throw new Error('No such class.')

  const live = changes.filter((c) => !c.undoneAt && c.date && dates.includes(String(c.date)))
  const offOn = new Set(live.filter((c) => removes(c.kind)).map((c) => `${c.meetingId}|${c.date}`))
  const added = live.filter((c) => !removes(c.kind))
  const offeringOf = new Map(offerings.map((o) => [String(o.offeringKey), o]))
  const label = (key: string) => String(offeringOf.get(key)?.courseCode ?? 'a class')

  /** What these offerings put on each date: their weekly meetings (minus
   * that date's cancellations) plus that date's extra classes. */
  const busyOf = (keys: Set<string>, group?: string | null): Busy[] => [
    ...dates.flatMap((date) =>
      meetings
        .filter(
          (m) =>
            keys.has(String(m.offeringKey)) &&
            m.day === weekdayOf(date) &&
            m.id !== a.ignoreMeetingId &&
            !offOn.has(`${m.id}|${date}`) &&
            (!m.group || !group || m.group === group),
        )
        .map((m) => ({
          date,
          start: String(m.startTime),
          end: String(m.endTime),
          room: m.room ? String(m.room) : undefined,
          label: label(String(m.offeringKey)),
        })),
    ),
    ...added
      .filter((c) => keys.has(String(c.offeringKey)))
      .map((c) => ({
        date: String(c.date),
        start: String(c.startTime),
        end: String(c.endTime),
        room: c.room ? String(c.room) : undefined,
        label: `${c.courseId} (extra class)`,
      })),
  ]

  // Who must be free: everyone registered in this offering.
  const attendees = regs.filter((r) => r.offeringKey === a.offeringKey).map((r) => String(r.rollId))
  const byRoll = new Map(regs.map((r) => [`${r.rollId}|${r.offeringKey}`, r]))
  const groupOf = new Map(
    students.map((s) => [
      `${s.rollPrefix ? String(s.rollPrefix) : `I${String(s.branch).toUpperCase()}`}${s.admissionYear}${String(s.rollNumber).padStart(3, '0')}`,
      s.subSection ? String(s.subSection) : null,
    ]),
  )
  const keysOf = (rollId: string) =>
    new Set(regs.filter((r) => r.rollId === rollId).map((r) => String(r.offeringKey)))

  // Students with identical timetables are one check, not sixty.
  const profiles = new Map<string, { students: string[]; busy: Busy[] }>()
  for (const rollId of attendees) {
    const keys = keysOf(rollId)
    const sig = [...keys].sort().join(',') + `|${groupOf.get(rollId) ?? ''}`
    if (!profiles.has(sig)) profiles.set(sig, { students: [], busy: busyOf(keys, groupOf.get(rollId)) })
    profiles.get(sig)!.students.push(rollId)
  }

  // The professor: every offering they teach, in any batch.
  const faculty = offering.faculty ? String(offering.faculty) : ''
  const facultyKeys = new Set(offerings.filter((o) => o.faculty === faculty).map((o) => String(o.offeringKey)))
  const professorBusy = faculty ? busyOf(facultyKeys) : []

  const n = Math.max(1, Math.ceil((a.minDurationMins ?? 60) / 60))
  const cands = candidates(n, dates, a.earliestTime || '00:00', a.latestTime || '23:59')
  const clash = (busy: Busy[], c: Candidate) => busy.find((b) => b.date === c.date && overlaps(c.start, c.end, b.start, b.end))

  // Rooms: every room the timetable uses, busy where a class holds it that date.
  const allRooms = [...new Set(meetings.filter((m) => m.room).map((m) => String(m.room)))]
  const roomBusy = busyOf(new Set(offerings.map((o) => String(o.offeringKey)))).filter((b) => b.room)
  const freeRoom = (c: Candidate) =>
    allRooms.filter((room) => !roomBusy.some((b) => b.room === room && b.date === c.date && overlaps(c.start, c.end, b.start, b.end)))[0] ?? null

  const rank = (c: Candidate) => {
    let score = 0
    const why = [`free for all ${attendees.length} registered student(s)`]
    if (faculty) why.push(`${faculty} is free`)
    if (c.start >= '09:00' && c.end <= '17:30') {
      score += 2
      why.push('within 9–5:30')
    } else why.push(c.start < '09:00' ? 'early start' : 'late finish')
    if (!overlaps(c.start, c.end, '12:00', '14:30')) {
      score += 2
      why.push('avoids the lunch hours')
    } else why.push('next to lunch')
    return { score, reason: why.join(' · ') }
  }

  const parties = [...profiles.values()].map((p) => ({ name: p.students.join(', '), size: p.students.length, busy: p.busy }))
  if (faculty) parties.push({ name: faculty, size: 0, busy: professorBusy })
  const free = cands.filter((c) => !parties.some((p) => clash(p.busy, c)))
  const ranked = free
    .map((c) => ({ ...c, ...rank(c), room: freeRoom(c) }))
    .sort((x, y) => y.score - x.score || x.date.localeCompare(y.date) || x.start.localeCompare(y.start))

  // Nothing fits: who blocks the most candidate slots, and with what?
  let blocking: { who: string; students: number; blocks: number; example: string | null; detail: string } | null = null
  if (!ranked.length && parties.length) {
    const worst = parties
      .map((p) => ({ p, blocked: cands.filter((c) => clash(p.busy, c)) }))
      .sort((x, y) => y.blocked.length - x.blocked.length)[0]
    const ex = worst.blocked[0]
    const with_ = ex ? clash(worst.p.busy, ex) : null
    blocking = {
      who: worst.p.size ? `${worst.p.size} student(s) (${worst.p.name.split(', ').slice(0, 3).join(', ')}${worst.p.size > 3 ? '…' : ''})` : worst.p.name,
      students: worst.p.size,
      blocks: worst.blocked.length,
      example: ex ? `${pretty(ex.date)} ${ex.start}–${ex.end}` : null,
      detail: ex
        ? `${worst.p.size ? `${worst.p.size} of the registered students` : worst.p.name} can't make ${worst.blocked.length} of the ${cands.length} slots — e.g. ${pretty(ex.date)} ${ex.start}–${ex.end}, when they have ${with_?.label ?? 'another class'}.`
        : 'No slot fits these constraints: try other dates, a wider window or a shorter class.',
    }
  }

  console.log(
    JSON.stringify({ event: 'slots-found', offering: a.offeringKey, dates, attendees: attendees.length, profiles: profiles.size, faculty, candidates: cands.length, free: ranked.length }),
  )
  return JSON.stringify({
    slots: ranked.slice(0, 12).map(({ date, day, start, end, score, reason, room }) => ({ date, day, start, end, score, reason, room })),
    totalFree: ranked.length,
    attendees: attendees.length,
    profiles: profiles.size,
    professors: faculty ? [faculty] : [],
    course: offering.courseCode,
    sections: offering.sections ?? [],
    blocking,
    unused: byRoll.size,
  })
}
