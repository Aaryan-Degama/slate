import { DAYS, HOURS, type Cell, type BusyEntry } from '../lib/grid'
import { courseColor } from '../lib/courseColor'
import { courseFullName } from '../lib/courseNames'
import './TimetableGrid.css'

function entryKey(e: BusyEntry): string {
  return e.id ?? `${e.courseId}|${e.day}|${e.startTime}|${e.endTime}|${e.section ?? ''}`
}

function unionEntries(a: BusyEntry[], b: BusyEntry[]): BusyEntry[] {
  const map = new Map<string, BusyEntry>()
  for (const e of [...a, ...b]) map.set(entryKey(e), e)
  return [...map.values()]
}

/** Clusters the hour-columns starting at hi into one wide cell, the way
 * the source spreadsheet itself does: a genuinely multi-hour class (real
 * start/end time) still renders as one merged cell, but a shorter class
 * that shares part of that same window is stacked INTO that cell instead
 * of being skipped over and dropped -- growing the span to cover the
 * longest entry pulled in, and re-checking after each growth in case
 * that pulled in something even longer. */
function clusterSpan(grid: Cell[][], di: number, hi: number): { span: number; busy: BusyEntry[] } {
  let busy = grid[di][hi].busy
  if (busy.length === 0) return { span: 1, busy: [] }
  let span = 1
  for (;;) {
    const maxEnd = busy.reduce((m, e) => (e.endTime > m ? e.endTime : m), '')
    let needed = span
    for (let j = hi + span; j < HOURS.length; j++) {
      if (HOURS[j].start !== HOURS[j - 1].end) break // gap (lunch)
      if (HOURS[j].start >= maxEnd) break
      needed++
    }
    if (needed === span) return { span, busy }
    for (let k = span; k < needed; k++) {
      busy = unionEntries(busy, grid[di][hi + k].busy)
    }
    span = needed
  }
}

export default function TimetableGrid({
  grid,
  freeIsHighlighted = false,
  onBusyClick,
  onEmptyClick,
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
}) {
  return (
    <table className="timetable-grid">
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
          const cells: React.ReactNode[] = []
          let hi = 0
          while (hi < HOURS.length) {
            const { span: colSpan, busy } = clusterSpan(grid, di, hi)
            const cell: Cell = { ...grid[di][hi], busy }
            cells.push(
              <GridCell
                key={HOURS[hi].start}
                cell={cell}
                colSpan={colSpan}
                freeIsHighlighted={freeIsHighlighted}
                onBusyClick={onBusyClick}
                onEmptyClick={onEmptyClick}
              />,
            )
            hi += colSpan
          }
          return (
            <tr key={day}>
              <th className="hour-label">{day}</th>
              {cells}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function GridCell({
  cell,
  colSpan,
  freeIsHighlighted,
  onBusyClick,
  onEmptyClick,
}: {
  cell: Cell
  colSpan: number
  freeIsHighlighted: boolean
  onBusyClick?: (entry: BusyEntry) => void
  onEmptyClick?: (day: string, start: string, end: string) => void
}) {
  const editable = Boolean(onBusyClick || onEmptyClick)

  if (cell.change) {
    const cls = cell.change.changeType === 'SCHEDULED' ? 'change-scheduled' : 'change-cancelled'
    return (
      <td className={`grid-cell ${cls}`} colSpan={colSpan}>
        <span className="course">{cell.change.courseId}</span>
        <span className="tag">
          {cell.change.changeType === 'SCHEDULED' ? 'Newly scheduled' : 'Cancelled'}
        </span>
      </td>
    )
  }

  if (cell.busy.length > 0) {
    return (
      <td className="grid-cell busy" colSpan={colSpan}>
        {cell.busy.map((b, i) => {
          const color = courseColor(b.courseId)
          const fullName = courseFullName(b.courseId)
          const tooltipLines = [fullName ?? b.courseId, b.faculty ? `Taught by ${b.faculty}` : null]
            .filter(Boolean)
            .join('\n')
          return (
            <div
              key={i}
              className={`course-block${editable ? ' editable' : ''} has-tooltip`}
              style={{ background: color.bg, borderLeftColor: color.accent }}
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
            </div>
          )
        })}
      </td>
    )
  }

  return (
    <td
      className={`grid-cell ${freeIsHighlighted ? 'free' : ''}${editable ? ' editable-empty' : ''}`}
      colSpan={colSpan}
      onClick={onEmptyClick ? () => onEmptyClick(cell.day, cell.start, cell.end) : undefined}
    >
      {editable && <span className="add-hint">+</span>}
    </td>
  )
}
