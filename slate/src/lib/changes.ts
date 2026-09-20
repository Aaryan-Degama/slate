// One action (e.g. "move IML from Thu to Fri for Sec A") is stored as one
// ScheduleChange row per affected section, and a move as two kinds of row.
// These helpers fold rows back into one entry per action for the feed, the
// history and the admin log.
import { formatDate, type ChangeEntry } from './grid'

export type ChangeRow = ChangeEntry & {
  offeringKey?: string | null
  meetingId?: string | null
  program?: string | null
  branch?: string | null
  semester?: number | null
  createdAt: string
}

export type Action = {
  groupId: string
  kind: 'CANCELLED' | 'EXTRA' | 'MOVED'
  courseId: string
  batch: string
  /** Sections reached (live ones first; all of them if the action is fully undone). */
  sections: string[]
  /** The class taken away (cancel / move) and the class put on (extra / move). */
  from: ChangeRow | null
  to: ChangeRow | null
  changedBy: string | null | undefined
  changedBySection: string | null | undefined
  createdAt: string
  /** Every row undone: the whole action is off. */
  undone: boolean
  /** Some sections took it off themselves. */
  partlyUndoneFor: string[]
  undoneBy: string | null | undefined
  /** The date the action is about (the later of from/to). */
  date: string
}

export function toActions(rows: ChangeRow[]): Action[] {
  const byGroup = new Map<string, ChangeRow[]>()
  for (const r of rows) {
    const k = r.groupId ?? r.id ?? ''
    byGroup.set(k, [...(byGroup.get(k) ?? []), r])
  }
  return [...byGroup.entries()]
    .map(([groupId, g]) => {
      const from = g.find((r) => r.kind === 'CANCELLED' || r.kind === 'MOVED_FROM') ?? null
      const to = g.find((r) => r.kind === 'EXTRA' || r.kind === 'MOVED_TO') ?? null
      const main = g.filter((r) => r.kind === (to ?? from)!.kind)
      const live = main.filter((r) => !r.undoneAt)
      const first = g[0]
      return {
        groupId,
        kind: from && to ? 'MOVED' : from ? 'CANCELLED' : 'EXTRA',
        courseId: first.courseId,
        batch: [first.program, first.branch, first.semester ? `Sem ${first.semester}` : ''].filter(Boolean).join(' '),
        sections: [...new Set((live.length ? live : main).map((r) => r.section).filter((x): x is string => !!x))].sort(),
        from,
        to,
        changedBy: first.changedBy,
        changedBySection: first.changedBySection,
        createdAt: g.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), first.createdAt),
        undone: live.length === 0,
            partlyUndoneFor: live.length
          ? [...new Set(main.filter((r) => r.undoneAt).map((r) => r.section).filter((x): x is string => !!x))].sort()
          : [],
        undoneBy: main.find((r) => r.undoneAt)?.undoneBy,
        date: [from?.date, to?.date].filter(Boolean).sort().pop()!,
      } satisfies Action
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const when = (r: ChangeRow) => `${formatDate(r.date)} ${r.startTime}–${r.endTime}`

/** "Cancelled on Fri 25 Sep 14:30–15:30" / "Moved Thu 24 Sep 09:00–10:00 → Fri 25 Sep 16:30–17:30" */
export function describe(a: Action): string {
  if (a.kind === 'MOVED') return `Moved ${when(a.from!)} → ${when(a.to!)}${a.to!.room ? ` in ${a.to!.room}` : ''}`
  if (a.kind === 'CANCELLED') return `Cancelled on ${when(a.from!)}`
  return `Extra class on ${when(a.to!)}${a.to!.room ? ` in ${a.to!.room}` : ''}`
}

export const KIND_TAG: Record<Action['kind'], string> = { CANCELLED: 'Cancelled', EXTRA: 'Extra', MOVED: 'Moved' }

/** "5 min ago", "3 h ago", "2 days ago" */
export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} days ago`
}
