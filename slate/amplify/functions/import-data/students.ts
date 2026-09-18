// Student-list rows -> checked records, using the admin-confirmed column
// mapping and the batch's real sections from TimetableSlot.

export type Mapping = { roll: number | null; email: number | null; section: number | null; subSection: number | null }
export type StudentRecord = {
  line: number
  year?: string
  roll?: number
  section?: string
  subSection?: string
  problems: string[]
}

/** IIT2024245 / 2024245 / iit2024245@iiita.ac.in -> year + roll; 245 -> roll only. */
export function parseId(value: string): { year?: string; roll?: number } {
  const v = value.trim()
  let m = /^(?:[A-Za-z]{2,4})?(\d{4})(\d{3})$/.exec(v)
  if (m) return { year: m[1], roll: Number(m[2]) }
  m = /^[A-Za-z]{2,4}(\d{4})(\d+)@/.exec(v)
  if (m) return { year: m[1], roll: Number(m[2]) }
  if (/^\d{1,3}$/.test(v)) return { roll: Number(v) }
  return {}
}

export function buildStudentRecords(
  rows: string[][],
  mapping: Mapping,
  batchSections: string[],
  yearInput?: string,
): StudentRecord[] {
  const letters = new Set(batchSections.map((s) => s[0]))
  const subs = new Set(batchSections.filter((s) => s.length === 2))
  const cell = (row: string[], c: number | null) => (c === null ? '' : (row[c] ?? '').trim())

  const recs = rows.map((row, i): StudentRecord => {
    const fromRoll = parseId(cell(row, mapping.roll))
    const id = fromRoll.roll !== undefined ? fromRoll : parseId(cell(row, mapping.email))
    const sub = cell(row, mapping.subSection).toUpperCase() || undefined
    const section = cell(row, mapping.section).toUpperCase() || sub?.[0]
    const problems: string[] = []
    if (id.roll === undefined) problems.push('no readable roll number')
    const year = id.year ?? (yearInput || undefined)
    if (!year) problems.push('no admission year (enter it)')
    if (!section) problems.push('no section')
    else if (!letters.has(section)) problems.push(`section ${section} isn't in this batch's timetable`)
    if (sub) {
      if (!subs.has(sub)) problems.push(`sub-section ${sub} isn't in this batch's timetable`)
      if (section && sub[0] !== section) problems.push(`sub-section ${sub} doesn't belong to section ${section}`)
    }
    return { line: i + 1, year, roll: id.roll, section, subSection: sub, problems }
  })

  const byStudent = new Map<string, StudentRecord[]>()
  for (const r of recs) {
    if (r.roll === undefined || !r.year) continue
    const k = `${r.year}|${r.roll}`
    byStudent.set(k, [...(byStudent.get(k) ?? []), r])
  }
  for (const group of byStudent.values()) {
    if (new Set(group.map((r) => `${r.section}|${r.subSection}`)).size > 1)
      group.forEach((r) => r.problems.push('same student listed with different sections'))
  }
  return recs
}
