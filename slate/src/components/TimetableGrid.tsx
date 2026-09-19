import { DAYS, HOURS, KIND_LABEL, personLabel, removes, type Cell, type BusyEntry, type ChangeEntry } from '../lib/grid'
import { courseColor } from '../lib/courseColor'
import { courseFullName } from '../lib/courseNames'
import './TimetableGrid.css'

type Span =
  | { kind: 'busy'; entry: BusyEntry; start: number; end: number }
  | { kind: 'change'; change: ChangeEntry; start: number; end: number }
type Placed = Span & { lane: number }

function busyKey(e: BusyEntry): string {
  return e.id ?? `${e.courseId}|${e.startTime}|${e.endTime}|${e.section ?? ''}`
}

/** Every class for one day, each spanning exactly the hour columns it
 * really covers, packed into lanes so overlapping classes of different
 * lengths sit on separate lines -- a 2-hour class stays one wide box
 * while a 1-hour class in the same window keeps its own 1-hour box, the
 * way the source spreadsheet lays it out. An HTML table can't express
 * that (colSpan cells can't overlap), hence the per-day CSS grid. */
function layoutDay(row: Cell[]): { items: Placed[]; lanes: number } {
  const spans = new Map<string, Span>()
  row.forEach((cell, hi) => {
    for (const e of cell.busy) {
      const key = `b:${busyKey(e)}`
      const existing = spans.get(key)
      if (existing) existing.end = hi
      else spans.set(key, { kind: 'busy', entry: e, start: hi, end: hi })
    }
    if (cell.change) {
      const c = cell.change
      const key = `c:${c.groupId ?? c.courseId}|${c.startTime}|${c.endTime}|${c.kind}`
      const existing = spans.get(key)
      if (existing) existing.end = hi
      else spans.set(key, { kind: 'change', change: c, start: hi, end: hi })
    }
  })

  // Section order first (A above B above C), then time; each goes in the
  // topmost line that's free for all of its hours.
  const section = (s: Span) => (s.kind === 'busy' ? s.entry.section ?? '' : '')
  const sorted = [...spans.values()].sort(
    (a, b) => section(a).localeCompare(section(b)) || a.start - b.start || b.end - a.end,
  )
  const lanes: Set<number>[] = []
  const items = sorted.map((s) => {
    const hours = Array.from({ length: s.end - s.start + 1 }, (_, i) => s.start + i)
    let lane = lanes.findIndex((used) => hours.every((h) => !used.has(h)))
    if (lane === -1) {
      lane = lanes.length
      lanes.push(new Set())
    }
    hours.forEach((h) => lanes[lane].add(h))
    return { ...s, lane }
  })
  return { items, lanes: Math.max(lanes.length, 1) }
}

export default function TimetableGrid({
  grid,
  freeIsHighlighted = false,
  onBusyClick,
  onEmptyClick,
  onChangeClick,
  dayLabels,
}: {
  grid: Cell[][]
  /** When true, an empty cell renders as a green "free" highlight
   * (New Request results). When false, empty just means no class
   * (student/teacher's own timetable). */
  freeIsHighlighted?: boolean
  /** Admin editor: click an existing class to edit/delete it. */
  onBusyClick?: (entry: BusyEntry) => void
  /** Admin editor: click an empty cell to add a class there. */
  onEmptyClick?: (day: string, start: string, end: string) => void
  /** CR: click an added class to withdraw it. */
  onChangeClick?: (change: ChangeEntry) => void
  /** Row labels, e.g. { MON: 'Mon 22 Sep' } for a dated week. */
  dayLabels?: Record<string, string>
}) {
  const editable = Boolean(onBusyClick || onEmptyClick)

  return (
    <table className="timetable-grid">
      <colgroup>
        <col className="day-col" />
        {HOURS.map((h) => (
          <col key={h.start} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th></th>
          {HOURS.map((hour) => (
            <th key={hour.start}>
              {hour.start}–{hour.end}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {DAYS.map((day, di) => {
          const row = grid[di]
          const { items, lanes } = layoutDay(row)
          return (
            <tr key={day}>
              <th className="hour-label">{dayLabels?.[day] ?? day}</th>
              <td className="day-lanes" colSpan={HOURS.length}>
                <div
                  className="day-grid"
                  style={{
                    gridTemplateColumns: `repeat(${HOURS.length}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${lanes}, auto)`,
                  }}
                >
                  {row.map((cell, hi) => {
                    // A cancelled class leaves its hour free (it stays visible, struck through).
                    const empty = cell.busy.every((b) => b.cancelled) && !cell.change
                    return (
                      <div
                        key={`bg-${cell.start}`}
                        className={`hour-bg${empty && freeIsHighlighted && !cell.outside ? ' free' : ''}${
                          empty && onEmptyClick ? ' editable-empty' : ''
                        }`}
                        style={{ gridColumn: `${hi + 1}`, gridRow: `1 / ${lanes + 1}` }}
                        onClick={
                          empty && onEmptyClick
                            ? () => onEmptyClick(cell.day, cell.start, cell.end)
                            : undefined
                        }
                      >
                        {empty && onEmptyClick && <span className="add-hint">+</span>}
                      </div>
                    )
                  })}
                  {items.map((it) => {
                    const style = {
                      gridColumn: `${it.start + 1} / ${it.end + 2}`,
                      gridRow: `${it.lane + 1}`,
                    }
                    if (it.kind === 'change') {
                      const cls = removes(it.change.kind) ? 'change-cancelled' : 'change-scheduled'
                      return (
                        <div
                          key={`c-${it.change.courseId}-${it.start}`}
                          className={`slot-item change-block ${cls}${onChangeClick ? ' editable' : ''} has-tooltip`}
                          style={style}
                          onClick={onChangeClick ? () => onChangeClick(it.change) : undefined}
                          data-tooltip={`${KIND_LABEL[it.change.kind]} · by ${personLabel(it.change.changedBy)}`}
                        >
                          <span className="course">
                            {it.change.courseId}
                            {it.change.room ? ` · ${it.change.room}` : ''}
                          </span>
                          <span className="tag">
                            {KIND_LABEL[it.change.kind]} · {personLabel(it.change.changedBy)}
                          </span>
                        </div>
                      )
                    }
                    return (
                      <CourseBlock
                        key={`b-${busyKey(it.entry)}`}
                        entry={it.entry}
                        style={style}
                        editable={editable}
                        onBusyClick={onBusyClick}
                      />
                    )
                  })}
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function CourseBlock({
  entry: b,
  style,
  editable,
  onBusyClick,
}: {
  entry: BusyEntry
  style: React.CSSProperties
  editable: boolean
  onBusyClick?: (entry: BusyEntry) => void
}) {
  const color = courseColor(b.courseId)
  const fullName = courseFullName(b.courseId)
  const tooltipLines = [
    fullName ?? b.courseId,
    b.faculty ? `Taught by ${b.faculty}` : null,
    b.cancelled ? `${KIND_LABEL[b.cancelled.kind]} by ${personLabel(b.cancelled.changedBy)}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div
      className={`slot-item course-block${editable ? ' editable' : ''}${b.cancelled ? ' cancelled' : ''} has-tooltip`}
      style={{ ...style, background: color.bg, borderLeftColor: color.accent }}
      onClick={onBusyClick ? () => onBusyClick(b) : undefined}
      data-tooltip={tooltipLines}
    >
      <div className="course-line">
        <span className="course-line-left">
          <span className="course" style={{ color: color.text }}>
            {b.courseId}
            {b.sessionType && ` (${b.sessionType.toUpperCase()})`}
            {b.section && (
              <>
                <span className="section-dot">·</span>
                <span className="section-label">Sec {b.section}</span>
              </>
            )}
          </span>
        </span>
        {b.room && <span className="meta room">{b.room}</span>}
      </div>
      {b.cancelled && (
        <span className="cancelled-tag">
          {KIND_LABEL[b.cancelled.kind]} · {personLabel(b.cancelled.changedBy)}
        </span>
      )}
    </div>
  )
}
