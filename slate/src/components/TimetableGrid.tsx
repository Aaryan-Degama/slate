import { DAYS, HOURS, type Cell, type BusyEntry } from '../lib/grid'
import { courseColor } from '../lib/courseColor'
import { courseFullName } from '../lib/courseNames'
import './TimetableGrid.css'

/** How many consecutive HOURS columns (starting at hi) a busy entry
 * actually covers, given its real start/end time -- so a 2-hour class
 * renders as one wide cell instead of repeating in each hour column it
 * touches. Stops at any gap in HOURS (e.g. lunch), which shouldn't
 * happen in real data but guards against a bad merge producing one. */
function spanCount(entry: BusyEntry, hi: number): number {
  let span = 0
  for (let j = hi; j < HOURS.length; j++) {
    const hour = HOURS[j]
    if (hour.start < entry.startTime || hour.end > entry.endTime) break
    if (j > hi && hour.start !== HOURS[j - 1].end) break
    span++
  }
  return Math.max(span, 1)
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
            const colSpan =
              cell.busy.length > 0
                ? Math.max(...cell.busy.map((b) => spanCount(b, hi)))
                : 1
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
