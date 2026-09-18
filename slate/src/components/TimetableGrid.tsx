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
          {DAYS.map((d) => (
            <th key={d}>{d}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {HOURS.map((hour, hi) => (
          <tr key={hour.start}>
            <th className="hour-label">
              {hour.start}–{hour.end}
            </th>
            {DAYS.map((day, di) => {
              const cell = grid[di][hi]
              return <GridCell key={day} cell={cell} freeIsHighlighted={freeIsHighlighted} />
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
