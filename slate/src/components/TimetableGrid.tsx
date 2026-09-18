import { DAYS, HOURS, type Cell } from '../lib/grid'
import './TimetableGrid.css'

export default function TimetableGrid({
  grid,
  freeIsHighlighted = false,
}: {
  grid: Cell[][]
  /** When true, an empty cell renders as a green "free" highlight
   * (New Request results). When false, empty just means no class
   * (student/teacher's own timetable). */
  freeIsHighlighted?: boolean
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
              return <GridCell key={hour.start} cell={cell} freeIsHighlighted={freeIsHighlighted} />
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GridCell({ cell, freeIsHighlighted }: { cell: Cell; freeIsHighlighted: boolean }) {
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
        {cell.busy.map((b, i) => (
          <div key={i} className="course-block">
            <span className="course">{b.courseId}</span>
            {b.section && <span className="meta">Sec {b.section}</span>}
            {b.room && <span className="meta">{b.room}</span>}
          </div>
        ))}
      </td>
    )
  }

  return <td className={`grid-cell ${freeIsHighlighted ? 'free' : ''}`}></td>
}
