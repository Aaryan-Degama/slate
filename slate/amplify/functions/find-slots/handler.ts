// Slot finding (CLAUDE.md §5). For each candidate *date*: every affected
// section's effective timetable (regular classes that weekday, minus that
// date's cancellations, plus that date's extra classes, plus the batch's
// electives) and the course professor's (their classes in any batch).
// Free intervals are intersected, filtered by the constraints, ranked with
// simple explainable rules, given a free room -- and when nothing works,
// the one section or professor whose absence opens up the most slots is
// named, with what they have then.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { HOURS } from '../../../src/lib/grid'

type Group = { program: string; branch: string; semester: number; section: string }
type Args = {
  groups: string[] // "program|branch|semester|section"
  dates: string[] // YYYY-MM-DD
  courseId?: string | null // adds the course professor's timetable
  ignoreSlotId?: string | null // a move: the class being moved doesn't block itself
  earliestTime?: string | null
  latestTime?: string | null
  minDurationMins?: number | null
}
type Row = Record<string, unknown>
type Busy = { date: string; start: string; end: string; room?: string; label: string }
/** One timetable that must be free: a section, or a professor. */
type Party = { name: string; kind: 'section' | 'professor'; busy: Busy[] }
type Candidate = { date: string; day: string; start: string; end: string }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TT = process.env.TIMETABLE_SLOT_TABLE!
const SC = process.env.SCHEDULE_CHANGE_TABLE!

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
  return `${weekdayOf(date)[0]}${weekdayOf(date).slice(1).toLowerCase()} ${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`
}
const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE
const label = (g: Group) => `${g.branch} Sem ${g.semester} Sec ${g.section}`
const inBatch = (r: Row, g: Group) => r.program === g.program && r.branch === g.branch && Number(r.semester) === g.semester

/** Does a class for `rowSection` keep (some of) group `g` busy? B1 and B2
 * classes occupy part of B, B classes all of B1/B2, and '*' (a batch-wide
 * elective) everyone. */
const blocks = (rowSection: string, g: string) =>
  rowSection === '*' || rowSection === g || rowSection === g[0] || (g.length === 1 && rowSection[0] === g && rowSection.length === 2)

const removes = (k: unknown) => k === 'CANCELLED' || k === 'MOVED_FROM'

/** Every run of `n` consecutive, gap-free class hours on each date. */
function candidates(n: number, dates: string[], earliest: string, latest: string): Candidate[] {
  const out: Candidate[] = []
  for (const date of dates) {
    const day = weekdayOf(date)
    if (day === 'SAT' || day === 'SUN') continue
    for (let i = 0; i + n <= HOURS.length; i++) {
      const hours = Array.from({ length: n }, (_, k) => i + k)
      if (hours.some((h, k) => k > 0 && HOURS[h].start !== HOURS[h - 1].end)) continue
      const start = HOURS[hours[0]].start
      const end = HOURS[hours[n - 1]].end
      if (start < earliest || end > latest) continue
      out.push({ date, day, start, end })
    }
  }
  return out
}

export const handler = async (event: { arguments: Args }) => {
  const a = event.arguments
  const groups: Group[] = a.groups.map((s) => {
    const [program, branch, semester, section] = s.split('|')
    return { program, branch, semester: Number(semester), section }
  })
  if (!groups.length) throw new Error('Pick at least one section.')
  const dates = [...new Set((a.dates ?? []).filter((d): d is string => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))].sort()
  if (!dates.length) throw new Error('Pick at least one date.')

  const [slots, changes] = await Promise.all([scanAll(TT), scanAll(SC)])
  const live = changes.filter((c) => !c.undoneAt && c.date && dates.includes(String(c.date)))
  // A regular class is off on a date if a live cancellation/move points at it.
  const offOn = new Set(live.filter((c) => removes(c.kind)).map((c) => `${c.relatedSlotId}|${c.date}`))
  const added = live.filter((c) => !removes(c.kind))

  /** Regular classes held on each date (weekday matches, not cancelled), plus that date's additions. */
  const held = (keep: (r: Row) => boolean): Busy[] => [
    ...dates.flatMap((date) =>
      slots
        .filter((r) => r.day === weekdayOf(date) && r.id !== a.ignoreSlotId && !offOn.has(`${r.id}|${date}`) && keep(r))
        .map((r) => ({
          date,
          start: String(r.startTime),
          end: String(r.endTime),
          room: r.room ? String(r.room) : undefined,
          label: `${r.courseId}${r.section === '*' ? ' (elective)' : ` (Sec ${r.section})`}`,
        })),
    ),
    ...added.filter(keep).map((c) => ({
      date: String(c.date),
      start: String(c.startTime),
      end: String(c.endTime),
      room: c.room ? String(c.room) : undefined,
      label: `${c.courseId} (extra class, Sec ${c.section})`,
    })),
  ]

  const parties: Party[] = groups.map((g) => ({
    name: label(g),
    kind: 'section',
    busy: held((r) => inBatch(r, g) && blocks(String(r.section), g.section)),
  }))
  // The course professor(s) for these sections (a course can have a
  // different professor per section).
  const professors = a.courseId
    ? [
        ...new Set(
          slots
            .filter((r) => r.courseId === a.courseId && r.faculty && groups.some((g) => inBatch(r, g) && (r.section === g.section || blocks(String(r.section), g.section))))
            .map((r) => String(r.faculty)),
        ),
      ]
    : []
  for (const prof of professors) parties.push({ name: prof, kind: 'professor', busy: held((r) => r.faculty === prof) })

  const n = Math.max(1, Math.ceil((a.minDurationMins ?? 60) / 60))
  const earliest = a.earliestTime || '00:00'
  const latest = a.latestTime || '23:59'
  const cands = candidates(n, dates, earliest, latest)
  const freeFor = (c: Candidate, pi: number) => !parties[pi].busy.some((b) => b.date === c.date && overlaps(c.start, c.end, b.start, b.end))
  const clashOf = (c: Candidate, pi: number) => parties[pi].busy.find((b) => b.date === c.date && overlaps(c.start, c.end, b.start, b.end))

  // Rooms: every room seen in the timetable, busy wherever a class held on
  // that date uses it. Prefer rooms these sections lecture in.
  const roomBusy = held(() => true).filter((b) => b.room)
  const allRooms = [...new Set(slots.filter((r) => r.room).map((r) => String(r.room)))]
  const lectureUse = new Map<string, number>()
  for (const p of parties) if (p.kind === 'section') for (const b of p.busy) if (b.room) lectureUse.set(b.room, (lectureUse.get(b.room) ?? 0) + 1)
  const labRooms = new Set(slots.filter((r) => r.sessionType === 'P' && r.room).map((r) => String(r.room)))
  const freeRoom = (c: Candidate) =>
    allRooms
      .filter((room) => !roomBusy.some((b) => b.room === room && b.date === c.date && overlaps(c.start, c.end, b.start, b.end)))
      .sort(
        (x, y) =>
          Number(labRooms.has(x)) - Number(labRooms.has(y)) || (lectureUse.get(y) ?? 0) - (lectureUse.get(x) ?? 0) || x.localeCompare(y),
      )[0] ?? null

  const sectionIdx = parties.map((p, i) => (p.kind === 'section' ? i : -1)).filter((i) => i >= 0)
  const rank = (c: Candidate) => {
    let score = 0
    const why: string[] = [groups.length > 1 ? `free for all ${groups.length} sections` : 'free for this section']
    if (professors.length) why.push(`${professors.join(' & ')} is free`)
    if (c.start >= '09:00' && c.end <= '17:30') {
      score += 2
      why.push('within 9–5:30')
    } else why.push(c.start < '09:00' ? 'early start' : 'late finish')
    if (!overlaps(c.start, c.end, '12:00', '14:30')) {
      score += 2
      why.push('avoids the lunch hours')
    } else why.push('next to lunch')
    // "Edge of the day": outside a section's first-to-last class that day
    // means students come in early, stay back, or come in just for this.
    const edge = sectionIdx.filter((pi) => {
      const today = parties[pi].busy.filter((b) => b.date === c.date)
      if (!today.length) return true
      const first = today.reduce((m, b) => (b.start < m ? b.start : m), '99')
      const last = today.reduce((m, b) => (b.end > m ? b.end : m), '00')
      return c.start < first || c.end > last
    })
    score -= edge.length
    why.push(edge.length ? `${edge.length} section(s) have no class around it that day` : "fits inside everyone's day")
    return { score, reason: why.join(' · ') }
  }

  const all = parties.map((_, i) => i)
  const common = cands.filter((c) => all.every((pi) => freeFor(c, pi)))
  const ranked = common
    .map((c) => ({ ...c, ...rank(c), room: freeRoom(c) }))
    .sort((x, y) => y.score - x.score || x.date.localeCompare(y.date) || x.start.localeCompare(y.start))

  // Nothing works: whose absence (a section's, or the professor's) opens up the most slots?
  let blocking: { party: string; kind: string; unlocks: number; example: string | null; detail: string } | null = null
  if (!ranked.length && parties.length > 1) {
    const options = all.map((pi) => ({ pi, opened: cands.filter((c) => all.every((o) => o === pi || freeFor(c, o))) }))
    const best = options.sort((x, y) => y.opened.length - x.opened.length)[0]
    const who = parties[best.pi]
    if (best.opened.length) {
      const ex = best.opened.map((c) => ({ c, ...rank(c) })).sort((x, y) => y.score - x.score)[0].c
      const clash = clashOf(ex, best.pi)
      const when = `${pretty(ex.date)} ${ex.start}–${ex.end}`
      blocking = {
        party: who.name,
        kind: who.kind,
        unlocks: best.opened.length,
        example: when,
        detail:
          who.kind === 'professor'
            ? `Every section is free ${best.opened.length} time(s), but ${who.name} teaches then — e.g. ${when} (${clash?.label ?? 'a class'}).`
            : `Without ${who.name}, ${best.opened.length} slot(s) work for everyone else — e.g. ${when}, when ${who.name} has ${clash?.label ?? 'a class'}.`,
      }
    } else {
      blocking = {
        party: '',
        kind: '',
        unlocks: 0,
        example: null,
        detail: 'Even leaving out any one section or the professor, nothing fits: try other dates, a wider time window or a shorter class.',
      }
    }
  }

  console.log(JSON.stringify({ event: 'slots-found', groups: a.groups, dates, courseId: a.courseId ?? null, professors, hours: n, candidates: cands.length, common: ranked.length, blocking: blocking?.party ?? null }))
  return JSON.stringify({
    slots: ranked.slice(0, 12).map(({ date, day, start, end, score, reason, room }) => ({ date, day, start, end, score, reason, room })),
    totalFree: ranked.length,
    professors,
    blocking,
  })
}
