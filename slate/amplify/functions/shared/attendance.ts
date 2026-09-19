// Who attends what (CLAUDE.md §4). A student attends their home section's
// classes, adjusted by their Enrollment exceptions:
//   DROP course C          -> not C in their home section
//   ADD  course C with S/B -> C's classes of section S in batch B
//                             (a drop-year/backlog student, or an elective;
//                             S = '*' for a batch-wide elective)
// Electives (section '*') are attended only by students enrolled in them.
// Until a student has any elective enrollment, they're shown every elective
// of their batch, flagged unconfirmed -- the data just isn't there yet.
//
// Used by section-changes (a student's own timetable) and find-slots (who
// must be free for a class). Pure functions over rows the caller scanned.

export type Row = Record<string, unknown>
export type Home = { rollId: string; program: string; branch: string; semester: number; section: string; subSection?: string }

// IIITA emails look like iit<admissionYear><rollNumber>@iiita.ac.in; the
// prefix picks the branch (IIT -> IT, IEC -> EC).
const ROLL_RE = /^([a-z]{2,4})(\d{4})(\d+)(?:@iiita\.ac\.in)?$/i
/** "iit2024245@iiita.ac.in" / "IIT2024245" -> parts; null if it isn't a student id. */
export function parseRoll(value: string) {
  const m = value.trim().match(ROLL_RE)
  if (!m) return null
  const [, prefix, year, rollStr] = m
  return {
    rollId: `${prefix}${year}${rollStr}`.toUpperCase(),
    branch: prefix.slice(1).toUpperCase(),
    year,
    roll: parseInt(rollStr, 10),
  }
}
/** "IIT" + 2024 + 45 -> "IIT2024045" */
export const rollIdOf = (branch: string, year: string, roll: number) => `I${branch.toUpperCase()}${year}${String(roll).padStart(3, '0')}`

/** A student's home section: the student list first, then a roll range. */
export function homeOf(value: string, students: Row[], ranges: Row[]): Home | null {
  const p = parseRoll(value)
  if (!p) return null
  const ok = (r: Row) => String(r.branch).toUpperCase() === p.branch && r.admissionYear === p.year
  const student = students.filter((r) => ok(r) && Number(r.rollNumber) === p.roll).sort((a, b) => Number(b.semester) - Number(a.semester))[0]
  if (student) {
    const sec = String(student.section)
    const sub = student.subSection ? String(student.subSection) : sec.length === 2 ? sec : undefined
    return {
      rollId: p.rollId,
      program: String(student.program),
      branch: String(student.branch),
      semester: Number(student.semester),
      section: sec[0],
      ...(sub ? { subSection: sub } : {}),
    }
  }
  const hits = ranges.filter((r) => ok(r) && p.roll >= Number(r.minRoll) && p.roll <= Number(r.maxRoll))
  const whole = hits.find((r) => String(r.section).length === 1)
  const sub = hits.find((r) => String(r.section).length === 2)
  const hit = whole ?? sub
  if (!hit) return null
  return {
    rollId: p.rollId,
    program: String(hit.program),
    branch: String(hit.branch),
    semester: Number(hit.semester),
    section: String(hit.section)[0],
    ...(sub ? { subSection: String(sub.section) } : {}),
  }
}

export const sameBatch = (r: Row, b: Row) =>
  r.program === b.program && r.branch === b.branch && Number(r.semester) === Number(b.semester)

/** Is a class for `rowSection` held for the group `g` (section, or sub-section)?
 * B1/B2 classes are held for part of B, B classes for all of B1/B2. */
export const heldFor = (rowSection: string, g: string) =>
  rowSection === g || rowSection === g[0] || (g.length === 1 && rowSection[0] === g && rowSection.length === 2)

/** Is a home-section class one this student sits in? (B student with sub-section B1: B and B1 classes, not B2.) */
const inHome = (rowSection: string, h: Home) =>
  rowSection === h.section || (h.subSection ? rowSection === h.subSection : rowSection[0] === h.section && rowSection.length === 2)

export type Attended = {
  /** Ids of every TimetableSlot row the student attends. */
  slotIds: string[]
  /** (course, group) pairs they attend -- to match extra classes, which aren't tied to a slot. */
  groups: { courseId: string; program: string; branch: string; semester: number; section: string }[]
  /** True when they're shown their batch's electives only because no elective enrollment exists yet. */
  electivesUnconfirmed: boolean
  /** Their timetable differs from their home section's (enrollments apply). */
  irregular: boolean
}

export function attended(h: Home, slots: Row[], enrollments: Row[]): Attended {
  const mine = enrollments.filter((e) => e.rollId === h.rollId)
  const drops = new Set(mine.filter((e) => e.action === 'DROP').map((e) => String(e.courseId)))
  const adds = mine.filter((e) => e.action === 'ADD')
  const homeBatch = slots.filter((r) => sameBatch(r, h))
  const electiveCourses = new Set(homeBatch.filter((r) => r.section === '*' || r.isElective).map((r) => String(r.courseId)))
  const electivesKnown = adds.some((e) => electiveCourses.has(String(e.courseId)))

  const picked = new Map<string, Row>()
  // Home section's regular (non-elective) classes, minus drops.
  for (const r of homeBatch)
    if (r.section !== '*' && !r.isElective && !drops.has(String(r.courseId)) && inHome(String(r.section), h)) picked.set(String(r.id), r)
  // Electives: until any are known, all of them (unconfirmed).
  if (!electivesKnown) for (const r of homeBatch) if ((r.section === '*' || r.isElective) && !drops.has(String(r.courseId))) picked.set(String(r.id), r)
  // Additions: that course's classes for that group.
  for (const e of adds)
    for (const r of slots)
      if (r.courseId === e.courseId && sameBatch(r, e) && (e.section === '*' || !e.section ? r.section === '*' || !!r.isElective : heldFor(String(r.section), String(e.section))))
        picked.set(String(r.id), r)

  const groups = new Map<string, Attended['groups'][number]>()
  for (const r of picked.values()) {
    const g = { courseId: String(r.courseId), program: String(r.program), branch: String(r.branch), semester: Number(r.semester), section: String(r.section) }
    groups.set(`${g.courseId}|${g.program}|${g.branch}|${g.semester}|${g.section}`, g)
  }
  return { slotIds: [...picked.keys()], groups: [...groups.values()], electivesUnconfirmed: !electivesKnown && electiveCourses.size > 0, irregular: mine.length > 0 }
}

/** Does a dated change touch a student who attends `a`? Removals by class id, additions by course + group. */
export function touches(c: Row, a: Attended): boolean {
  if (c.kind === 'CANCELLED' || c.kind === 'MOVED_FROM') return a.slotIds.includes(String(c.relatedSlotId))
  return a.groups.some(
    (g) => g.courseId === c.courseId && sameBatch(c, g) && (heldFor(String(c.section), g.section) || heldFor(g.section, String(c.section)) || g.section === '*'),
  )
}
