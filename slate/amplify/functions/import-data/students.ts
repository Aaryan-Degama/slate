// Student-list rows -> checked records, using the admin-confirmed column
// mapping and the batch's real sections from TimetableSlot.

export type Mapping = { roll: number | null; email: number | null; name: number | null; section: number | null; subSection: number | null }
export type StudentRecord = {
  line: number
  year?: string
  roll?: number
  /** IIT / IIB / IEC ... -- roll numbers restart per prefix. */
  prefix?: string
  name?: string
  section?: string
  subSection?: string
  problems: string[]
}

/** IIT2024245 / 2024245 / iit2024245@iiita.ac.in -> prefix + year + roll; 245 -> roll only. */
export function parseId(value: string): { year?: string; roll?: number; prefix?: string } {
  const v = value.trim()
  let m = /^([A-Za-z]{2,4})?(\d{4})(\d{3})$/.exec(v)
  if (m) return { prefix: m[1]?.toUpperCase(), year: m[2], roll: Number(m[3]) }
  m = /^([A-Za-z]{2,4})(\d{4})(\d+)@/.exec(v)
  if (m) return { prefix: m[1].toUpperCase(), year: m[2], roll: Number(m[3]) }
  if (/^\d{1,3}$/.test(v)) return { roll: Number(v) }
  return {}
}

export type Overrides = { section?: string; subSection?: string }

/** One sheet can list every programme of an admission year (IIT, IIB, IEC,
 * BD*). `onlyPrefixes` says which of them this batch takes. */
export const prefixesIn = (rows: string[][], col: number | null) =>
  col === null
    ? []
    : [...new Set(rows.map((r) => parseId((r[col] ?? '').trim()).prefix).filter((p): p is string => !!p))].sort()

export function buildStudentRecords(
  rows: string[][],
  mapping: Mapping,
  batchSections: string[],
  yearInput?: string,
  overrides: Overrides = {},
  onlyPrefixes: string[] = [],
): StudentRecord[] {
  const wanted = onlyPrefixes.map((p) => p.toUpperCase())
  const oSub = overrides.subSection?.trim().toUpperCase() || undefined
  const oSec = overrides.section?.trim().toUpperCase() || oSub?.[0]
  const letters = new Set(batchSections.map((s) => s[0]))
  const subs = new Set(batchSections.filter((s) => s.length === 2))
  const cell = (row: string[], c: number | null) => (c === null ? '' : (row[c] ?? '').trim())

  const recs = rows.map((row, i): StudentRecord => {
    const fromRoll = parseId(cell(row, mapping.roll))
    const id = fromRoll.roll !== undefined ? fromRoll : parseId(cell(row, mapping.email))
    // Another programme's student in the same sheet: not this batch's.
    if (wanted.length && id.prefix && !wanted.includes(id.prefix))
      return { line: i + 1, year: id.year, roll: id.roll, prefix: id.prefix, problems: ['other-programme'] }
    const problems: string[] = []
    // Sheets mark some names with a trailing "*" (e.g. a hostel/day-scholar
    // flag); it isn't part of the name.
    const name = cell(row, mapping.name).replace(/\*+$/, '').trim() || undefined
    const fileSec = cell(row, mapping.section).toUpperCase() || undefined
    let fileSub = cell(row, mapping.subSection).toUpperCase() || undefined
    // A lab-group column that just says 1/2 means <section>1/<section>2.
    if (fileSub && /^\d$/.test(fileSub) && (fileSec ?? oSec)) fileSub = `${fileSec ?? oSec}${fileSub}`
    if (fileSec && oSec && fileSec !== oSec) problems.push(`file says section ${fileSec}, row override says ${oSec}`)
    if (fileSub && oSub && fileSub !== oSub) problems.push(`file says ${fileSub}, row override says ${oSub}`)
    const sub = fileSub ?? oSub
    const section = fileSec ?? oSec ?? sub?.[0]
    if (id.roll === undefined) problems.push('no readable roll number')
    const year = id.year ?? (yearInput || undefined)
    if (!year) problems.push('no admission year (enter it)')
    if (!section) problems.push('no section')
    else if (!letters.has(section)) problems.push(`section ${section} isn't in this batch's timetable`)
    if (sub) {
      if (!subs.has(sub)) problems.push(`sub-section ${sub} isn't in this batch's timetable`)
      if (section && sub[0] !== section) problems.push(`sub-section ${sub} doesn't belong to section ${section}`)
    }
    return { line: i + 1, year, roll: id.roll, prefix: id.prefix, name, section, subSection: sub, problems }
  })

  // Course lists (e.g. attendance registers) also carry students from other
  // years repeating the course; they aren't members of this batch's section.
  const yearCounts = new Map<string, number>()
  for (const r of recs) if (r.year) yearCounts.set(r.year, (yearCounts.get(r.year) ?? 0) + 1)
  const mainYear = [...yearCounts].sort((a, b) => b[1] - a[1])[0]?.[0]
  for (const r of recs) {
    if (r.year && mainYear && r.year !== mainYear)
      r.problems.push(`admission year ${r.year} differs from the rest of the list (${mainYear}), likely repeating the course`)
  }

  const byStudent = new Map<string, StudentRecord[]>()
  for (const r of recs) {
    if (r.roll === undefined || !r.year) continue
    // Prefix included: IIB2024001 and IIT2024001 are two students.
    const k = `${r.prefix ?? ''}|${r.year}|${r.roll}`
    byStudent.set(k, [...(byStudent.get(k) ?? []), r])
  }
  for (const group of byStudent.values()) {
    if (new Set(group.map((r) => `${r.section}|${r.subSection}`)).size > 1)
      group.forEach((r) => r.problems.push('same student listed with different sections'))
  }
  return recs
}
