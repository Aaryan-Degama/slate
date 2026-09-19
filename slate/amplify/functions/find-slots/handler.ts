// Slot finding (CLAUDE.md §5): interval intersection across every
// requested section, constraint filtering, simple explainable ranking, a
// free-room pass, and -- when nothing works -- the section whose removal
// opens up the most slots.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { DAYS, HOURS } from '../../../src/lib/grid'

type Group = { program: string; branch: string; semester: number; section: string }
type Args = {
  groups: string[] // "program|branch|semester|section"
  earliestTime?: string | null
  latestTime?: string | null
  allowedDays?: (string | null)[] | null
  minDurationMins?: number | null
}
type Row = Record<string, unknown>
type Busy = { day: string; start: string; end: string; room?: string; section: string; label: string }
type Candidate = { day: string; start: string; end: string; hours: number[] }

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

const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE
const label = (g: Group) => `${g.program} ${g.branch} Sem ${g.semester} Sec ${g.section}`

/** Does a class for `rowSection` keep (some of) group `g` busy? B1 and B2
 * classes occupy part of B, and B classes occupy all of B1/B2. */
const blocks = (rowSection: string, g: string) =>
  rowSection === g || rowSection === g[0] || (g.length === 1 && rowSection[0] === g && rowSection.length === 2)

/** Every run of `n` consecutive, gap-free class hours on each allowed day. */
function candidates(n: number, days: string[], earliest: string, latest: string): Candidate[] {
  const out: Candidate[] = []
  for (const day of days) {
    for (let i = 0; i + n <= HOURS.length; i++) {
      const hours = Array.from({ length: n }, (_, k) => i + k)
      if (hours.some((h, k) => k > 0 && HOURS[h].start !== HOURS[h - 1].end)) continue
      const start = HOURS[hours[0]].start
      const end = HOURS[hours[n - 1]].end
      if (start < earliest || end > latest) continue
      out.push({ day, start, end, hours })
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

  const [slots, changes] = await Promise.all([scanAll(TT), scanAll(SC)])
  const scheduled = changes.filter((c) => c.changeType === 'SCHEDULED')

  // Busy intervals per requested group.
  const busyFor = (g: Group): Busy[] => [
    ...slots
      .filter(
        (r) =>
          r.program === g.program && r.branch === g.branch && Number(r.semester) === g.semester && blocks(String(r.section), g.section),
      )
      .map((r) => ({
        day: String(r.day),
        start: String(r.startTime),
        end: String(r.endTime),
        room: r.room ? String(r.room) : undefined,
        section: String(r.section),
        label: `${r.courseId} (Sec ${r.section})`,
      })),
    ...scheduled
      .filter((c) => c.program === g.program && c.branch === g.branch && blocks(String(c.section), g.section))
      .map((c) => ({
        day: String(c.day),
        start: String(c.startTime),
        end: String(c.endTime),
        room: c.room ? String(c.room) : undefined,
        section: String(c.section),
        label: `${c.courseId} (already scheduled)`,
      })),
  ]
  const busy = groups.map(busyFor)

  const n = Math.max(1, Math.ceil((a.minDurationMins ?? 60) / 60))
  const allowed = (a.allowedDays ?? []).filter((d): d is string => !!d)
  const days = DAYS.filter((d) => !allowed.length || allowed.includes(d))
  const earliest = a.earliestTime || '00:00'
  const latest = a.latestTime || '23:59'
  const cands = candidates(n, days, earliest, latest)
  const freeFor = (c: Candidate, gi: number) => !busy[gi].some((b) => b.day === c.day && overlaps(c.start, c.end, b.start, b.end))

  // Rooms: every room seen in the timetable, busy wherever any class or
  // scheduled session uses it. Prefer rooms these sections lecture in.
  const roomBusy = [...slots, ...scheduled].filter((r) => r.room)
  const allRooms = [...new Set(roomBusy.map((r) => String(r.room)))]
  const lectureUse = new Map<string, number>()
  for (const b of busy.flat()) if (b.room) lectureUse.set(b.room, (lectureUse.get(b.room) ?? 0) + 1)
  const labRooms = new Set(slots.filter((r) => r.sessionType === 'P' && r.room).map((r) => String(r.room)))
  const freeRoom = (c: Candidate) =>
    allRooms
      .filter((room) => !roomBusy.some((r) => r.room === room && r.day === c.day && overlaps(c.start, c.end, String(r.startTime), String(r.endTime))))
      .sort(
        (x, y) =>
          Number(labRooms.has(x)) - Number(labRooms.has(y)) || (lectureUse.get(y) ?? 0) - (lectureUse.get(x) ?? 0) || x.localeCompare(y),
      )[0] ?? null

  const rank = (c: Candidate) => {
    let score = 0
    const why: string[] = [groups.length > 1 ? `free for all ${groups.length} sections` : 'free for this section']
    if (c.start >= '09:00' && c.end <= '17:30') {
      score += 2
      why.push('within 9–5')
    } else why.push(c.start < '09:00' ? 'early start' : 'late finish')
    if (!overlaps(c.start, c.end, '12:00', '14:30')) {
      score += 2
      why.push('avoids the lunch hours')
    } else why.push('next to lunch')
    // "Edge of the day": outside a section's first-to-last class that day
    // means students come in early, stay back, or come in just for this.
    const edge = groups.filter((_, gi) => {
      const today = busy[gi].filter((b) => b.day === c.day)
      if (!today.length) return true
      const first = today.reduce((m, b) => (b.start < m ? b.start : m), '99')
      const last = today.reduce((m, b) => (b.end > m ? b.end : m), '00')
      return c.start < first || c.end > last
    })
    score -= edge.length
    why.push(edge.length ? `${edge.length} section(s) have no class around it that day` : 'fits inside everyone\'s day')
    return { score, reason: why.join(' · ') }
  }

  const all = groups.map((_, gi) => gi)
  const common = cands.filter((c) => all.every((gi) => freeFor(c, gi)))
  const ranked = common
    .map((c) => ({ ...c, ...rank(c), room: freeRoom(c) }))
    .sort((x, y) => y.score - x.score || DAYS.indexOf(x.day as never) - DAYS.indexOf(y.day as never) || x.start.localeCompare(y.start))

  let blocking: { section: string; unlocks: number; example: string | null; detail: string } | null = null
  if (!ranked.length && groups.length > 1) {
    const options = groups.map((g, gi) => {
      const others = all.filter((x) => x !== gi)
      const opened = cands.filter((c) => others.every((o) => freeFor(c, o)))
      return { g, gi, opened }
    })
    const best = options.sort((x, y) => y.opened.length - x.opened.length)[0]
    if (best.opened.length) {
      const ex = best.opened.map((c) => ({ c, ...rank(c) })).sort((x, y) => y.score - x.score)[0].c
      const clash = busy[best.gi].find((b) => b.day === ex.day && overlaps(ex.start, ex.end, b.start, b.end))
      blocking = {
        section: label(best.g),
        unlocks: best.opened.length,
        example: `${ex.day} ${ex.start}–${ex.end}`,
        detail: `Without ${label(best.g)}, ${best.opened.length} slot(s) work for everyone else — e.g. ${ex.day} ${ex.start}–${ex.end}, when ${label(best.g)} has ${clash?.label ?? 'a class'}.`,
      }
    } else {
      blocking = {
        section: '',
        unlocks: 0,
        example: null,
        detail: 'Dropping any single section still leaves no common slot: try other days, a wider time window or a shorter duration.',
      }
    }
  }

  console.log(JSON.stringify({ event: 'slots-found', groups: a.groups, hours: n, candidates: cands.length, common: ranked.length, blocking: blocking?.section ?? null }))
  return JSON.stringify({
    slots: ranked.slice(0, 12).map(({ day, start, end, score, reason, room }) => ({ day, start, end, score, reason, room })),
    totalFree: ranked.length,
    blocking,
    busy: busy.map((b, gi) => ({ group: label(groups[gi]), classes: b.length })),
  })
}
