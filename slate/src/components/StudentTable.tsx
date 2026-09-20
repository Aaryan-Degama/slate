import { useMemo, useState } from 'react'

/** One student as the table shows them. */
export type StudentTableRow = {
  rollId: string
  name: string
  admissionYear: string
  rollNumber: number
  section: string
  subSection: string
  /** From an uploaded student list, or filled in from a roll range. */
  source: 'list' | 'range'
}
type SortKey = keyof Omit<StudentTableRow, 'source'> | 'source'

const isSub = (s: string) => /^[A-Z]\d$/.test(s)

/** Build the rows from what the app knows: the uploaded students, plus
 * everyone a roll range covers but no list names -- that's who the app
 * matches by range. Keyed by the full roll id, because numbering restarts
 * per prefix (IIB2024001 is not IIT2024001). */
export function buildStudentRows(
  students: {
    admissionYear: string
    rollNumber: number
    rollPrefix?: string | null
    name?: string | null
    branch: string
    section: string
    subSection?: string | null
  }[],
  ranges: { admissionYear: string; section: string; minRoll: number; maxRoll: number }[],
  branch: string,
): StudentTableRow[] {
  const rows: StudentTableRow[] = students.map((s) => ({
    rollId: `${s.rollPrefix || `I${s.branch.toUpperCase()}`}${s.admissionYear}${String(s.rollNumber).padStart(3, '0')}`,
    name: s.name ?? '',
    admissionYear: s.admissionYear,
    rollNumber: s.rollNumber,
    section: s.section[0],
    subSection: s.subSection ?? (isSub(s.section) ? s.section : ''),
    source: 'list',
  }))
  const listed = new Set(rows.map((r) => r.rollId))
  const prefix = `I${branch.toUpperCase()}`
  for (const r of ranges.filter((r) => !isSub(r.section)))
    for (let n = r.minRoll; n <= r.maxRoll; n++) {
      const rollId = `${prefix}${r.admissionYear}${String(n).padStart(3, '0')}`
      if (listed.has(rollId)) continue
      const sub = ranges.find((x) => isSub(x.section) && x.section[0] === r.section && x.admissionYear === r.admissionYear && n >= x.minRoll && n <= x.maxRoll)
      rows.push({
        rollId,
        name: '',
        admissionYear: r.admissionYear,
        rollNumber: n,
        section: r.section,
        subSection: sub?.section ?? '',
        source: 'range',
      })
    }
  return rows
}

/** The batch's students as a sheet: searchable, sortable, filterable by
 * section. Used by the admin's Students tab and by a student's My Batch. */
export default function StudentTable({
  rows,
  fileName,
  meRollId,
  crByRollId = {},
}: {
  rows: StudentTableRow[]
  /** Base name for the CSV download. */
  fileName: string
  /** Highlighted as "you". */
  meRollId?: string
  /** Roll id -> section, for the CR tag. */
  crByRollId?: Record<string, string>
}) {
  const [q, setQ] = useState('')
  const [section, setSection] = useState('')
  const [source, setSource] = useState<'' | 'list' | 'range'>('')
  // Alphabetical by name; students with no name yet (roll ranges, older
  // uploads) fall to the end rather than to the top.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = rows.filter(
      (r) =>
        (!needle || r.rollId.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)) &&
        (!section || r.section === section) &&
        (!source || r.source === source),
    )
    const { key, dir } = sort
    return [...filtered].sort((a, b) => {
      const x = a[key]
      const y = b[key]
      if (key === 'name' && !x !== !y) return x ? -1 : 1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir
    })
  }, [rows, q, section, source, sort])

  const sections = [...new Set(rows.map((r) => r.section))].sort()
  const named = rows.filter((r) => r.name).length
  const header = (key: SortKey, label: string) => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 1 ? -1 : 1 }))} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {label} {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : ''}
    </th>
  )
  const csv = () => {
    const text = [
      'name,roll,year,section',
      ...shown.map((r) => [`"${r.name.replace(/"/g, '""')}"`, r.rollId, r.admissionYear, r.subSection || r.section].join(',')),
    ].join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="filter-bar">
        <input placeholder="Search name or roll" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="sort-toggle" role="group" aria-label="Sort by">
          <button type="button" className={sort.key === 'name' ? 'active' : ''} onClick={() => setSort({ key: 'name', dir: 1 })}>
            Name
          </button>
          <button type="button" className={sort.key === 'rollId' ? 'active' : ''} onClick={() => setSort({ key: 'rollId', dir: 1 })}>
            Roll
          </button>
        </div>
        <select value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="">All sections ({rows.length})</option>
          {sections.map((s) => (
            <option key={s} value={s}>
              Section {s} ({rows.filter((r) => r.section === s).length})
            </option>
          ))}
        </select>
        {named < rows.length && (
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="">Named and unnamed</option>
            <option value="list">With names ({named})</option>
            <option value="range">From roll ranges ({rows.length - named})</option>
          </select>
        )}
        <span className="meta">{shown.length} shown</span>
        <button type="button" onClick={csv} disabled={!shown.length}>
          Download CSV
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="meta">No students match.</p>
      ) : (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                {header('name', 'Name')}
                {header('rollId', 'Roll')}
                {header('admissionYear', 'Year')}
                {header('section', 'Section')}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={r.rollId} className={r.rollId === meRollId ? 'me' : undefined}>
                  <td className="meta">{i + 1}</td>
                  <td>
                    {r.name || <span className="meta">—</span>}
                    {r.rollId === meRollId && <span className="tag"> you</span>}
                    {crByRollId[r.rollId] && <span className="tag"> CR</span>}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.rollId}</td>
                  <td>{r.admissionYear}</td>
                  <td>{r.subSection || r.section}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
