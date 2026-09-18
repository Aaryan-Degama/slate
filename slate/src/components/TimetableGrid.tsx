import { DAYS, HOURS, type Cell, type BusyEntry } from '../lib/grid'
import { courseColor } from '../lib/courseColor'
import { courseFullName } from '../lib/courseNames'
import './TimetableGrid.css'

function entryKey(e: BusyEntry): string {
  return e.id ?? `${e.courseId}|${e.day}|${e.startTime}|${e.endTime}|${e.section ?? ''}`
}

/** True when two hour-columns' busy lists are the exact same set of
 * entries -- i.e. genuinely the same multi-hour class continuing, not
 * just "some entry here happens to be long enough to cover both." */
function sameEntries(a: BusyEntry[], b: BusyEntry[]): boolean {
  if (a.length !== b.length) return false
  const keys = new Set(a.map(entryKey))
  return b.every((e) => keys.has(entryKey(e)))
}

/** How many consecutive HOURS columns (starting at hi) render as one
 * wide cell. Only merges a column into the span when it holds the exact
 * same busy entries as hi -- if a *different* class starts partway
 * through what looks like a multi-hour block (e.g. a neighboring 1-hour
 * class squeezed next to a 2-hour one), the span stops there instead of
 * skipping over it and silently dropping it from the render. */
function spanCount(grid: Cell[][], di: number, hi: number): number {
  const cell = grid[di][hi]
  if (cell.busy.length === 0) return 1
  let span = 1
  for (let j = hi + 1; j < HOURS.length; j++) {
    if (HOURS[j].start !== HOURS[j - 1].end) break // gap (lunch)
    if (!sameEntries(grid[di][j].busy, cell.busy)) break
    span++
  }
  return span
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
            const cell = grid[di][hi]
            const colSpan = spanCount(grid, di, hi)
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
