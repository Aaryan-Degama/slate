// Registration rows (ENROLL | STUDENTNAME | COURSENAME | FACULTYNAME) ->
// Registration records, by matching each row to an *offering* of the
// student's batch (docs/DATA-MODEL.md).
//
// The file names courses in words and the timetable uses codes, so the
// match is by professor first -- the timetable stores one per course and
// section, which is what makes an offering -- and by course name second,
// for offerings whose professor is written differently.

export type Row = Record<string, unknown>
export type RegRow = { line: number; rollId: string; course: string; faculty: string }

const words = (s: string) =>
  s
    .toUpperCase()
    .replace(/\b(DR|PROF|MR|MRS|MS|SHRI|SMT)\b\.?/g, ' ')
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** "PROF. ANUPAM" and "Prof. Anupam Agarwal" are one person: every word of
 * the shorter name appears in the longer one. */
export function sameFaculty(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)]
  if (!x.length || !y.length) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  // Timetables shorten and mistype names ("Dr. Nikhiland" for Dr.
  // Nikhilanand Arya), so a word counts as matched when it prefixes one of
  // the other's, or when both are long and share a seven-letter stem.
  const like = (v: string, w: string) =>
    v === w || v.startsWith(w) || w.startsWith(v) || (v.length >= 7 && w.length >= 7 && v.slice(0, 7) === w.slice(0, 7))
  return short.every((w) => long.some((v) => like(v, w)))
}

/** Course names are sometimes truncated or punctuated differently. */
const nameKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
export const sameCourseName = (a: string, b: string) => {
  const [x, y] = [nameKey(a), nameKey(b)]
  return x.length > 4 && y.length > 4 && (x === y || x.startsWith(y) || y.startsWith(x))
}

export type Match = { offeringKey?: string; reason?: string }

/** Which offering of this batch is this registration row? */
export function matchOffering(reg: RegRow, offerings: Row[]): Match {
  const byFaculty = reg.faculty ? offerings.filter((o) => o.faculty && sameFaculty(String(o.faculty), reg.faculty)) : []
  if (byFaculty.length === 1) return { offeringKey: String(byFaculty[0].offeringKey) }

  const byName = offerings.filter((o) => o.courseName && sameCourseName(String(o.courseName), reg.course))
  if (byName.length === 1) return { offeringKey: String(byName[0].offeringKey) }

  // Both narrow it down: the professor's offering of that course.
  const both = byFaculty.filter((o) => byName.some((n) => n.offeringKey === o.offeringKey))
  if (both.length === 1) return { offeringKey: String(both[0].offeringKey) }

  if (byName.length > 1) return { reason: `${reg.course}: several offerings match and the professor didn't narrow it` }
  if (byFaculty.length > 1) return { reason: `${reg.course}: ${reg.faculty} teaches several courses here` }
  return { reason: `${reg.course}${reg.faculty ? ` (${reg.faculty})` : ''}: no matching class in this batch` }
}
