// Timetable rows -> Course / Offering / ClassMeeting (docs/DATA-MODEL.md).
//
// An *offering* is one course as actually taught: one professor, one
// audience. IML in IT Sem 5 is three offerings, because Sections A, B and C
// each have their own professor -- and that is exactly what a student
// registers for. A *meeting* is one weekly slot of an offering.

export type Row = {
  courseId: string
  section: string
  day: string
  startTime: string
  endTime: string
  room?: string
  sessionType: string
  faculty: string | null
  isElective: boolean
}
export type Batch = { program: string; branch: string; semester: number }
export type Legend = Record<string, { name: string; ltps: number[] | null; core: boolean }>

/** Same professor written two ways is still one offering. */
export const facultyKey = (name: string | null) =>
  (name ?? '')
    .toUpperCase()
    .replace(/\b(DR|PROF|MR|MRS|MS)\b\.?/g, ' ')
    .replace(/[^A-Z]/g, '')

export const offeringKeyOf = (term: string, b: Batch, courseCode: string, faculty: string | null) =>
  `${term}|${b.program}|${b.branch}|${b.semester}|${courseCode}|${facultyKey(faculty)}`

/** "MDM-5 FA" is a minor degree module, "OPEN ELECTIVE ..." an open
 * elective, a basket entry an elective; everything the legend calls a core
 * course is core. */
export function kindOf(code: string, row: Row, legend: Legend): 'CORE' | 'ELECTIVE' | 'MINOR' | 'OPEN_ELECTIVE' {
  if (/^MDM/i.test(code)) return 'MINOR'
  if (/^OE|OPEN/i.test(code)) return 'OPEN_ELECTIVE'
  if (legend[code]?.core) return 'CORE'
  return row.isElective ? 'ELECTIVE' : 'CORE'
}

export type Built = {
  courses: { term: string; code: string; name?: string; kind: string; ltps?: string }[]
  offerings: {
    offeringKey: string
    term: string
    courseCode: string
    courseName?: string
    kind: string
    faculty?: string
    sections: string[]
  }[]
  meetings: {
    offeringKey: string
    term: string
    day: string
    startTime: string
    endTime: string
    room?: string
    sessionType?: string
    group?: string
  }[]
}

export function buildOfferings(rows: Row[], batch: Batch, legend: Legend, term: string): Built {
  const courses = new Map<string, Built['courses'][number]>()
  const offerings = new Map<string, Built['offerings'][number]>()
  const meetings = new Map<string, Built['meetings'][number]>()

  for (const r of rows) {
    const code = r.courseId
    const kind = kindOf(code, r, legend)
    const info = legend[code]
    if (!courses.has(code))
      courses.set(code, {
        term,
        code,
        ...(info?.name ? { name: info.name } : {}),
        kind,
        ...(info?.ltps ? { ltps: info.ltps.join('-') } : {}),
      })

    const key = offeringKeyOf(term, batch, code, r.faculty)
    const offering = offerings.get(key) ?? {
      offeringKey: key,
      term,
      courseCode: code,
      ...(info?.name ? { courseName: info.name } : {}),
      kind,
      ...(r.faculty ? { faculty: r.faculty } : {}),
      sections: [] as string[],
    }
    if (!offering.sections.includes(r.section)) offering.sections.push(r.section)
    offerings.set(key, offering)

    // A class held for B1 only is the same offering as B's, meeting for
    // that half; the section itself is on the offering.
    const group = r.section.length === 2 ? r.section : undefined
    const mk = `${key}|${r.day}|${r.startTime}|${r.endTime}|${group ?? ''}|${r.sessionType}`
    if (!meetings.has(mk))
      meetings.set(mk, {
        offeringKey: key,
        term,
        day: r.day,
        startTime: r.startTime,
        endTime: r.endTime,
        ...(r.room ? { room: r.room } : {}),
        ...(r.sessionType ? { sessionType: r.sessionType } : {}),
        ...(group ? { group } : {}),
      })
  }

  for (const o of offerings.values()) o.sections.sort()
  return { courses: [...courses.values()], offerings: [...offerings.values()], meetings: [...meetings.values()] }
}

/** How a meeting is recognised again on the next import. */
export const meetingKey = (m: Record<string, unknown>) =>
  `${m.offeringKey}|${m.day}|${m.startTime}|${m.endTime}|${m.group ?? ''}|${m.sessionType ?? ''}`
