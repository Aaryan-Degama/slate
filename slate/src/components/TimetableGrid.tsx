import { DAYS, HOURS, type Cell, type BusyEntry } from '../lib/grid'
import { courseColor } from '../lib/courseColor'
import './TimetableGrid.css'

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
        {DAYS.map((day, di) => (
          <tr key={day}>
            <th className="hour-label">{day}</th>
            {HOURS.map((hour, hi) => {
              const cell = grid[di][hi]
              return (
                <GridCell
                  key={hour.start}
                  cell={cell}
                  freeIsHighlighted={freeIsHighlighted}
                  onBusyClick={onBusyClick}
                  onEmptyClick={onEmptyClick}
                />
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GridCell({
  cell,
  freeIsHighlighted,
  onBusyClick,
  onEmptyClick,
}: {
  cell: Cell
  freeIsHighlighted: boolean
  onBusyClick?: (entry: BusyEntry) => void
  onEmptyClick?: (day: string, start: string, end: string) => void
}) {
  const editable = Boolean(onBusyClick || onEmptyClick)

  if (cell.change) {
    const cls = cell.change.changeType === 'SCHEDULED' ? 'change-scheduled' : 'change-cancelled'
    return (
      <td className={`grid-cell ${cls}`}>
        <span className="course">{cell.change.courseId}</span>
        <span className="tag">
          {cell.change.changeType === 'SCHEDULED' ? 'Newly scheduled' : 'Cancelled'}
        </span>
      </td>
    )
  }

  if (cell.busy.length > 0) {
    return (
      <td className="grid-cell busy">
        {cell.busy.map((b, i) => {
          const color = courseColor(b.courseId)
          return (
            <div
              key={i}
              className={`course-block${editable ? ' editable' : ''}`}
              style={{ background: color.bg, borderLeftColor: color.accent }}
              onClick={onBusyClick ? () => onBusyClick(b) : undefined}
            >
              <div className="course-line">
                <span className="course" style={{ color: color.text }}>
                  {b.courseId}
                </span>
                {b.section && <span className="meta">Sec {b.section}</span>}
                {b.room && <span className="meta">{b.room}</span>}
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
      onClick={onEmptyClick ? () => onEmptyClick(cell.day, cell.start, cell.end) : undefined}
    >
      {editable && <span className="add-hint">+</span>}
    </td>
  )
}
