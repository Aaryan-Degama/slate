// Timetable reader (read -> map -> validate). Started as a port of
// scripts/timetable_reader.py; this version is now the reference (the
// Python script doesn't handle sheets whose classes name no section).
import type { Worksheet } from 'exceljs'

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const TIME_RANGE_RE = /^\s*(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})\s*$/
const ENTRY_RE = /^\s*([A-Za-z][A-Za-z.&]*)\s*\(\s*([LTP])\s*\)\s*-\s*(?:Sec\s*)?(.+?)\s*\(([^)]+)\)\s*$/
const SECTION_RE = /^[A-Z]\d?$/
// "DSP (L)", "ESD (P) 5118", "SSD (L) CC-3, 5254", "CE (L) (CC3- 5207)": no section named.
const PLAIN_RE = /^\s*([A-Za-z][A-Za-z0-9.&-]*)\s*\(\s*([LTP])\s*\)\s*(.*)$/
// Elective and minor slots are written without a session type, one course
// per line, sometimes under an "MDM-3" heading (a minor-degree slot):
//   MDM-3 EF (CC3-5107)
//   EBE (CC3-5255)
// Everyone in the batch may take them; who actually attends comes from
// their registrations (docs/DATA-MODEL.md).
const BASKET_RE = /^\s*(?:(MDM-\d+)\s+)?([A-Za-z][A-Za-z0-9.&-]*)\s*\(\s*([A-Za-z]{1,3}[\d-]{2,}[^)]*)\)\s*$/
const LTPS_RE = /^\s*\d+(?:\.\d+)?\s*[-–—]\s*\d+\s*[-–—]\s*\d+\s*[-–—]\s*\d+\s*$/
const CODE_RE = /^[A-Za-z][A-Za-z0-9-]{0,11}$/
const CATEGORY_RE = /^(PCC|PEC|OEC|BSC|ESC|HSMC|MDM|AEC|VAC|SEC|PC|PE|OE)\b/i
const CORE_CATEGORY_RE = /^(PCC|BSC|ESC|PC)\b/i
/** Placeholder section for classes on a sheet that names none (single-section batch). */
export const WHOLE_BATCH = '*'
// Cohort labels the real sheets use instead of sections, meaning the whole
// batch: "All", "IT-BI" (both programmes in the batch), "Both".
const WHOLE_BATCH_LABEL = /^(all|both|IT-BI|BI-IT)$/i

/** "CC-3, 5254" / "(CC3- 5207)" / "CC-3 5154" -> "CC3-5254"; a bare "5118" stays as is. */
function normRoom(raw: string): string | null | undefined {
  const t = raw.replace(/[()]/g, ' ').trim()
  if (!t) return null
  const cc = /^CC\s*-?\s*(\d)\s*[-,]?\s*(\d{3,4})$/i.exec(t)
  if (cc) return `CC${cc[1]}-${cc[2]}`
  if (/^\d{3,4}$/.test(t)) return t
  if (/^[A-Z]{1,3}\s*-?\s*\d{3,4}$/i.test(t)) return t.replace(/\s+/g, '')
  return undefined
}

type Range = { top: number; left: number; bottom: number; right: number }
type Hour = { start: string; end: string; cols: number[] }
type SheetCell = { coord: string; day: string; hours: number[]; fullHeight: boolean; text: string }
type LegendEntry = {
  name: string
  ltps: number[] | null
  faculty: Record<string, string>
  /** Listed on its own with a core category (PCC/BSC/...), i.e. taken by the whole section. */
  core: boolean
}

export type Row = {
  program: string | null
  branch: string | null
  semester: number | null
  day: string
  startTime: string
  endTime: string
  courseId: string
  sessionType: string
  section: string
  room: string
  faculty: string | null
  source: string
  duration: string
  /** A basket elective: held for the whole batch (section '*'), attended
   * only by the students enrolled in it (see Enrollment in the schema). */
  isElective: boolean
}
type WorkRow = Omit<Row, 'program' | 'branch' | 'semester' | 'faculty'> & { longEndTime: string | null }
export type Skipped = { coord: string; day: string; text: string; reason: string }
export type Issue = { type: string; detail?: string; course?: string; section?: string; kind?: string; row?: string; rows?: string[] }
export type SheetRollRange = {
  section: string
  /** Roll prefix, e.g. IIT / IEC: names the branch (IIT -> IT, IEC -> EC). */
  prefix: string
  admissionYear: string
  minRoll: number
  maxRoll: number
}
export type SheetResult = {
  sheet: string
  title: string
  batch: { program: string | null; branch: string | null; semester: number | null }
  /** Classes name no section (single-section batch); the admin says which. */
  needsSection: boolean
  /** "Sec A | IIT2026001 to IIT2026154" lines printed under the grid. */
  rollRanges: SheetRollRange[]
  rows: Row[]
  skipped: Skipped[]
  issues: Issue[]
  /** Course code -> what the sheet's legend says about it. */
  legend: Record<string, { name: string; ltps: number[] | null; core: boolean; faculty: Record<string, string> }>
}

const to24h = (h: string, m: string) => {
  let hh = Number(h)
  if (hh < 8) hh += 12 // sheet writes afternoon hours as 1:00, 2:30, ...
  return `${String(hh).padStart(2, '0')}:${m}`
}
const minutes = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const colLetter = (c: number) => {
  let s = ''
  while (c > 0) {
    const r = (c - 1) % 26
    s = String.fromCharCode(65 + r) + s
    c = Math.floor((c - 1) / 26)
  }
  return s
}

function parseRange(ref: string): Range {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)!
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
  return { top: Number(m[2]), left: col(m[1]), bottom: Number(m[4]), right: col(m[3]) }
}

const SEC_LABEL_RE = /^Sec(?:tion)?\.?\s*([A-Z]\d?)$/i
const RANGE_RE = /^([A-Z]{2,4})(\d{4})(\d{3})\s*(?:to|-|–|—)\s*(?:[A-Z]{2,4})?(?:\d{4})?(\d{3})$/i

/** Rows like "Sec A | IIT2026001 to IIT2026154" anywhere below the grid. */
function readRollRanges(text: (r: number, c: number) => string, fromRow: number, maxRow: number, maxCol: number) {
  const out: SheetRollRange[] = []
  for (let r = fromRow; r <= maxRow; r++) {
    for (let c = 1; c < maxCol; c++) {
      const sec = SEC_LABEL_RE.exec(text(r, c).trim())
      if (!sec) continue
      const range = RANGE_RE.exec(text(r, c + 1).trim())
      if (!range) continue
      const [, prefix, year, lo, hi] = range
      if (Number(hi) < Number(lo)) continue
      out.push({ section: sec[1].toUpperCase(), prefix: prefix.toUpperCase(), admissionYear: year, minRoll: Number(lo), maxRoll: Number(hi) })
    }
  }
  return out
}

/** Cell text, '' for the non-anchor cells of a merge (exceljs throws on those). */
export function cellText(ws: Worksheet, r: number, c: number): string {
  const cell = ws.getCell(r, c)
  if (cell.isMerged && cell.master.address !== cell.address) return ''
  try {
    return (cell.text ?? '').toString().trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- step 1

function readSheet(ws: Worksheet) {
  const merges = ((ws.model as { merges?: string[] }).merges ?? []).map(parseRange)
  const mergeOf = (r: number, c: number) =>
    merges.find((m) => m.top <= r && r <= m.bottom && m.left <= c && c <= m.right)
  const text = (r: number, c: number) => {
    const cell = ws.getCell(r, c)
    if (cell.isMerged && cell.master.address !== cell.address) return '' // exceljs echoes master value
    return (cell.text ?? '').toString()
  }
  const maxCol = ws.columnCount
  const maxRow = ws.rowCount
  const title = text(1, 1)

  let headerRow = 0
  for (let r = 1; r < 15 && !headerRow; r++) {
    let hits = 0
    for (let c = 1; c <= maxCol; c++) if (TIME_RANGE_RE.test(text(r, c))) hits++
    if (hits >= 3) headerRow = r
  }
  if (!headerRow) throw new Error('no header row with time ranges found')

  const hours: Hour[] = []
  for (let c = 1; c <= maxCol; c++) {
    const m = TIME_RANGE_RE.exec(text(headerRow, c))
    if (!m) continue
    const start = to24h(m[1], m[2])
    if (start === '13:00') continue // lunch column
    const mr = mergeOf(headerRow, c)
    const cols = mr ? Array.from({ length: mr.right - mr.left + 1 }, (_, i) => mr.left + i) : [c]
    hours.push({ start, end: to24h(m[3], m[4]), cols })
  }
  const colToHour = new Map<number, number>()
  hours.forEach((h, i) => h.cols.forEach((c) => colToHour.set(c, i)))

  const blocks: { day: string; rows: number[] }[] = []
  for (let r = headerRow + 1; r <= maxRow; ) {
    const v = text(r, 1).trim().toUpperCase()
    if (DAYS.includes(v)) {
      const mr = mergeOf(r, 1)
      const last = mr ? mr.bottom : r
      blocks.push({ day: v, rows: Array.from({ length: last - r + 1 }, (_, i) => r + i) })
      r = last + 1
    } else if (blocks.length) break
    else r++
  }

  const cells: SheetCell[] = []
  const hourCols = [...colToHour.keys()].sort((a, b) => a - b)
  for (const b of blocks) {
    for (const row of b.rows) {
      for (const c of hourCols) {
        const v = text(row, c).trim()
        if (!v || v.toUpperCase() === 'LUNCH') continue
        const mr = mergeOf(row, c)
        const cols = mr ? Array.from({ length: mr.right - mr.left + 1 }, (_, i) => mr.left + i) : [c]
        const top = mr ? mr.top : row
        const bottom = mr ? mr.bottom : row
        const hourIdx = [...new Set(cols.filter((x) => colToHour.has(x)).map((x) => colToHour.get(x)!))].sort(
          (a, b) => a - b,
        )
        cells.push({
          coord: `${colLetter(c)}${row}`,
          day: b.day,
          hours: hourIdx,
          fullHeight: b.rows.every((r) => r >= top && r <= bottom),
          text: text(row, c),
        })
      }
    }
  }

  const lastRow = blocks.length ? blocks[blocks.length - 1].rows.at(-1)! + 1 : headerRow + 1
  const roomNote = /Room\s*No\.?\s*for\s*Lectures\s*:\s*([^\n|]+)/i.exec(title)?.[1] ?? ''
  const lectureRooms = roomNote.split(/,\s*(?=CC)|\band\b/i).map((r) => normRoom(r)).filter(Boolean)
  return {
    title,
    hours,
    cells,
    legend: readLegend(text, lastRow, maxRow, maxCol),
    lectureRoom: lectureRooms.length === 1 ? lectureRooms[0]! : null,
    rollRanges: readRollRanges(text, lastRow, maxRow, maxCol),
  }
}

// Two layouts: a block under a "Course Code" header (IT sheets, ECE
// elective list), and header-less rows of code, name, category, credits,
// L-T-P-S, faculty (ECE core courses). Any row with an L-T-P-S cell counts.
function readLegend(text: (r: number, c: number) => string, fromRow: number, maxRow: number, maxCol: number) {
  const legend: Record<string, LegendEntry> = {}
  let headers: Map<string, number> | null = null
  const hcol = (...names: string[]) => {
    for (const [k, c] of headers!) if (names.some((n) => k.includes(n))) return c
    return null
  }
  for (let r = fromRow; r <= maxRow; r++) {
    const cells = Array.from({ length: maxCol }, (_, i) => text(r, i + 1).trim())
    if (cells.some((c) => c.toLowerCase() === 'course code')) {
      headers = new Map(cells.map((c, i) => [c.toLowerCase(), i + 1]))
      continue
    }
    const ltpsIdx = cells.findIndex((c) => LTPS_RE.test(c))
    if (ltpsIdx < 0) continue

    let codeCell = ''
    let name = ''
    let faculty = ''
    let category = ''
    if (headers) {
      const codeC = hcol('course code')
      const nameC = hcol('course name')
      const facC = hcol('facult')
      codeCell = codeC ? cells[codeC - 1] : ''
      name = nameC ? cells[nameC - 1] : ''
      faculty = facC ? cells[facC - 1] : ''
    } else {
      const codeIdx = cells.findIndex(
        (c, i) => i < ltpsIdx && c && c.split(/\n|\|/).every((x) => CODE_RE.test(x.trim())),
      )
      if (codeIdx < 0) continue
      codeCell = cells[codeIdx]
      name = cells.find((c, i) => i > codeIdx && /[a-z]/.test(c)) ?? ''
      category = cells.find((c) => CATEGORY_RE.test(c)) ?? ''
      faculty = cells.find((c, i) => i > ltpsIdx && /[A-Za-z]/.test(c)) ?? ''
    }
    const codes = codeCell.split(/\n|\|/).map((c) => c.trim()).filter(Boolean)
    const nums = cells[ltpsIdx].split(/\s*[-–—]\s*/).map(Number)
    for (const code of codes) {
      legend[code] = {
        name,
        ltps: nums.length === 4 && nums.every((n) => !Number.isNaN(n)) ? nums : null,
        faculty: parseFaculty(codes.length > 1 ? '' : faculty),
        core: !headers && codes.length === 1 && CORE_CATEGORY_RE.test(category),
      }
    }
  }
  return legend
}

function parseFaculty(raw: string): Record<string, string> {
  const t = raw.trim()
  if (!t) return {}
  const bySec: Record<string, string> = {}
  for (const m of t.matchAll(/([^,()]+?)\s*\(([^)]+)\)/g)) {
    const tokens = m[2].trim().replace(/\bSec(?:tion)?\.?\s*/gi, '').split(/[,\s]+/).filter(Boolean)
    const name = m[1].trim().replace(/^(?:and|&)\s+/i, '')
    if (tokens.length && tokens.every((s) => SECTION_RE.test(s))) for (const s of tokens) bySec[s] = name
  }
  return Object.keys(bySec).length ? bySec : { '*': t }
}

// ---------------------------------------------------------------- step 2

function mapEntries(sheet: ReturnType<typeof readSheet>) {
  const { hours } = sheet
  const rows: WorkRow[] = []
  const skipped: Skipped[] = []
  for (const cell of sheet.cells) {
    const long = cell.hours.length > 1
    const ambiguous = long && !cell.fullHeight
    for (const raw of cell.text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const skip = (reason: string) => skipped.push({ coord: cell.coord, day: cell.day, text: line, reason })
      let code: string, kind: string, room: string | null, sections: string[]
      let elective = false
      const m = ENTRY_RE.exec(line)
      const p = m ? null : PLAIN_RE.exec(line)
      if (m) {
        let secs: string
        ;[, code, kind, secs, room] = m as unknown as [string, string, string, string, string]
        sections = secs.trim().split(/[,\s]+/).filter(Boolean)
        if (!sections.every((s) => SECTION_RE.test(s))) {
          // Not sections but a cohort label the sheets use for "everyone in
          // this batch" ("All", "IT-BI"): a whole-batch class, elective or
          // not per the course list. Anything else we can't place.
          if (!WHOLE_BATCH_LABEL.test(secs.trim())) {
            skip(`no section, only a cohort label ("${secs.trim()}")`)
            continue
          }
          elective = !sheet.legend[code.trim()]?.core
          sections = [WHOLE_BATCH]
        }
        room = room!.replace(/\s+/g, '')
      } else if (p) {
        // No section named. A core course (per the course list) is taken by
        // the whole batch; anything else the list knows is an elective --
        // also whole-batch here, but only its enrolled students attend it.
        ;[, code, kind] = p as unknown as [string, string, string]
        const info = sheet.legend[code.trim()]
        if (!info) {
          skip('no section, and not in the course list')
          continue
        }
        elective = !info.core
        const r = normRoom(p[3])
        if (r === undefined) {
          skip(`couldn't read the room "${p[3].trim()}"`)
          continue
        }
        room = r ?? (kind.toUpperCase() === 'P' ? null : sheet.lectureRoom)
        sections = [WHOLE_BATCH]
      } else {
        const bas = BASKET_RE.exec(line)
        if (!bas) {
          skip('not in a "CODE (L/T/P) ..." form')
          continue
        }
        // "MDM-3 EF (CC3-5107)": an elective/minor class for the batch.
        code = bas[2]
        kind = 'L'
        room = bas[3].replace(/\s+/g, '')
        sections = [WHOLE_BATCH]
        elective = true
      }
      const first = cell.hours[0]
      const last = cell.hours[cell.hours.length - 1]
      for (const section of sections) {
        rows.push({
          day: cell.day,
          startTime: hours[first].start,
          endTime: hours[long && !ambiguous ? last : first].end,
          longEndTime: ambiguous ? hours[last].end : null,
          courseId: code.trim(),
          sessionType: kind.toUpperCase(),
          section,
          room: room ?? '',
          isElective: elective,
          source: cell.coord,
          duration: ambiguous ? 'ambiguous' : long ? 'merge' : 'single',
        })
      }
    }
  }
  // A sheet can list the same class twice in one slot (e.g. on two
  // sub-rows of the same day); keep one.
  const seen = new Set<string>()
  const unique = rows.filter((r) => {
    const k = [r.day, r.courseId, r.sessionType, r.section, r.startTime, r.room].join('|')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { rows: unique, skipped }
}

// ---------------------------------------------------------------- step 3

// An elective (section '*') is held for the whole batch, so its hours
// count towards every group's total for that course.
const applies = (rowSection: string, group: string) =>
  rowSection === WHOLE_BATCH || rowSection === group || rowSection === group[0]
const short = (r: WorkRow) =>
  `${r.courseId} (${r.sessionType}) Sec ${r.section} ${r.day} ${r.startTime}-${r.endTime} [${r.source}]`

function atomicGroups(rows: WorkRow[]) {
  const secs = new Set(rows.map((r) => r.section))
  // '*' is only a group of its own when the sheet names no sections at all.
  if (secs.size > 1) secs.delete(WHOLE_BATCH)
  return [...secs]
    .filter((s) => !(s.length === 1 && [...secs].some((x) => x.length === 2 && x[0] === s)))
    .sort()
}

function weeklyHours(rows: WorkRow[], group: string, code: string) {
  let lt = 0
  let p = 0
  for (const r of rows) {
    if (r.courseId !== code || !applies(r.section, group)) continue
    const h = (minutes(r.endTime) - minutes(r.startTime)) / 60
    if (r.sessionType === 'P') p += h
    else lt += h
  }
  return [lt, p]
}

function validate(rows: WorkRow[], legend: Record<string, LegendEntry>): Issue[] {
  const issues: Issue[] = []
  const groups = atomicGroups(rows)

  const hasLegend = Object.keys(legend).length > 0
  for (const code of [...new Set(rows.map((r) => r.courseId))].filter((c) => hasLegend && !legend[c]).sort())
    issues.push({ type: 'unknown-course', course: code, detail: "course code not in the sheet's course legend" })

  // Ambiguous merges: take the long reading only where every section it
  // covers is short of its legend hours by at least that much.
  const deficit = new Map<string, number>()
  for (const [code, info] of Object.entries(legend)) {
    if (!info.ltps) continue
    const [l, t, p] = info.ltps
    for (const g of groups) {
      const [lt, pp] = weeklyHours(rows, g, code)
      if (lt || pp) {
        deficit.set(`${code}|${g}|LT`, l + t - lt)
        deficit.set(`${code}|${g}|P`, p - pp)
      }
    }
  }
  for (const r of rows) {
    if (r.duration !== 'ambiguous') continue
    const extra = (minutes(r.longEndTime!) - minutes(r.endTime)) / 60
    const kind = r.sessionType === 'P' ? 'P' : 'LT'
    const keys = groups.filter((g) => applies(r.section, g)).map((g) => `${r.courseId}|${g}|${kind}`)
    if (keys.length && keys.every((k) => deficit.has(k) && deficit.get(k)! >= extra)) {
      r.endTime = r.longEndTime!
      keys.forEach((k) => deficit.set(k, deficit.get(k)! - extra))
      r.duration = 'ambiguous->long (matches L-T-P-S)'
    } else if (keys.length && keys.every((k) => deficit.has(k))) {
      r.duration = 'ambiguous->short (matches L-T-P-S)'
    } else {
      r.duration = 'ambiguous->short (UNVERIFIED, no L-T-P-S)'
      issues.push({ type: 'unverified-duration', row: short(r), detail: 'merge spans several hours on one sub-row; no legend hours to decide 1hr vs longer' })
    }
  }
  for (const [key, d] of [...deficit].sort()) {
    if (d === 0) continue
    const [course, section, kind] = key.split('|')
    issues.push({ type: 'hours-mismatch', course, section, kind, detail: `legend says ${d > 0 ? '+' : ''}${d}h/week vs what the sheet shows` })
  }

  const byDay = new Map<string, WorkRow[]>()
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r])
  for (const rs of byDay.values()) {
    rs.forEach((a, i) => {
      for (const b of rs.slice(i + 1)) {
        if (!(a.startTime < b.endTime && b.startTime < a.endTime)) continue
        if (a.room && a.room === b.room && a.courseId !== b.courseId) issues.push({ type: 'room-clash', rows: [short(a), short(b)] })
        if (a.courseId !== b.courseId && groups.some((g) => applies(a.section, g) && applies(b.section, g)))
          issues.push({ type: 'section-clash', rows: [short(a), short(b)] })
      }
    })
  }
  return issues
}

// ---------------------------------------------------------------- entry

function batchFromTitle(title: string) {
  const sem = /(\d+)\s*(?:st|nd|rd|th)\s+Semester/i.exec(title)
  const branch = /B\.?\s*Tech\.?\s*\((\w+)\)/i.exec(title)
  return {
    program: /B\.?\s*Tech/i.test(title) ? 'BTech' : null,
    branch: branch ? branch[1] : null,
    semester: sem ? Number(sem[1]) : null,
  }
}

export function processSheet(ws: Worksheet): SheetResult {
  const sheet = readSheet(ws)
  const batch = batchFromTitle(sheet.title)
  const { rows, skipped } = mapEntries(sheet)
  const issues = validate(rows, sheet.legend)
  return {
    sheet: ws.name,
    title: sheet.title,
    batch,
    // Electives stay whole-batch; only unsectioned *core* rows need the
    // admin to say which section they belong to.
    needsSection: rows.some((r) => r.section === WHOLE_BATCH && !r.isElective),
    rollRanges: sheet.rollRanges,
    rows: rows.map(({ longEndTime: _, ...r }) => {
      const fac = sheet.legend[r.courseId]?.faculty ?? {}
      return { ...r, ...batch, faculty: fac[r.section] ?? fac[r.section[0]] ?? fac['*'] ?? null }
    }),
    skipped,
    issues,
    legend: Object.fromEntries(
      Object.entries(sheet.legend).map(([code, l]) => [code, { name: l.name, ltps: l.ltps, core: l.core, faculty: l.faculty }]),
    ),
  }
}

// ---------------------------------------------------------------- template

// Slate's flat template: one row per class. Any sheet the grid reader
// can't handle can be copied into this and imported exactly.
export const TEMPLATE_HEADERS = ['Day', 'Start', 'End', 'Course', 'Type', 'Section', 'Room', 'Faculty']
const TEMPLATE_ALIASES: Record<string, RegExp> = {
  day: /^day$/,
  start: /^(start|from|start time)$/,
  end: /^(end|to|end time)$/,
  course: /^(course|course code|subject|code)$/,
  type: /^(type|session|session type|l\/p\/t|ltp)$/,
  section: /^(section|sec)$/,
  room: /^(room|venue|room no\.?)$/,
  faculty: /^(faculty|teacher|instructor|professor)$/,
}
const DAY_NAMES: Record<string, string> = { MON: 'MON', TUE: 'TUE', WED: 'WED', THU: 'THU', FRI: 'FRI', SAT: 'SAT' }

/** "9:00", "09:00", "2:30 pm", "14:30", "9" -> "HH:MM"; afternoon hours without am/pm follow the sheet convention (<8 = pm). */
function parseTime(raw: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(raw)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ?? '00'
  if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12
  else if (!m[3] && h < 8) h += 12
  if (h > 23 || Number(min) > 59) return null
  return `${String(h).padStart(2, '0')}:${min}`
}

/** Returns null when the sheet isn't in the template layout. */
export function readTemplate(ws: Worksheet): SheetResult | null {
  const text = (r: number, c: number) => cellText(ws, r, c)
  let headerRow = 0
  let cols: Record<string, number> = {}
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r++) {
    const found: Record<string, number> = {}
    for (let c = 1; c <= ws.columnCount; c++) {
      const h = text(r, c).toLowerCase()
      for (const [k, re] of Object.entries(TEMPLATE_ALIASES)) if (!(k in found) && re.test(h)) found[k] = c
    }
    if (['day', 'start', 'end', 'course', 'section'].every((k) => k in found)) {
      headerRow = r
      cols = found
    }
  }
  if (!headerRow) return null

  const rows: WorkRow[] = []
  const faculty = new Map<WorkRow, string | null>()
  const skipped: Skipped[] = []
  const get = (r: number, k: string) => (cols[k] ? text(r, cols[k]) : '')
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const vals = Object.keys(cols).map((k) => get(r, k))
    if (!vals.some(Boolean)) continue
    const coord = `row ${r}`
    const day = DAY_NAMES[get(r, 'day').slice(0, 3).toUpperCase()]
    const start = parseTime(get(r, 'start'))
    const end = parseTime(get(r, 'end'))
    const course = get(r, 'course')
    const type = (get(r, 'type') || 'L').toUpperCase()
    const sections = get(r, 'section').toUpperCase().split(/[,\s]+/).filter(Boolean)
    const problem = !day
      ? `day "${get(r, 'day')}" isn't MON-SAT`
      : !start || !end
        ? `couldn't read the time "${get(r, 'start')}-${get(r, 'end')}"`
        : end <= start
          ? 'end time is not after the start time'
          : !course
            ? 'no course'
            : !/^[LTP]$/.test(type)
              ? `type "${type}" isn't L, P or T`
              : !sections.length || !sections.every((s) => SECTION_RE.test(s))
                ? `section "${get(r, 'section')}" isn't like A or B1`
                : null
    if (problem) {
      skipped.push({ coord, day: day ?? get(r, 'day'), text: vals.filter(Boolean).join(' | '), reason: problem })
      continue
    }
    for (const section of sections) {
      const row: WorkRow = {
        day: day!,
        startTime: start!,
        endTime: end!,
        longEndTime: null,
        courseId: course,
        sessionType: type,
        section,
        // The Slate template asks for a section per row, so nothing in it
        // is a whole-batch elective.
        isElective: false,
        room: get(r, 'room').replace(/\s+/g, ''),
        source: coord,
        duration: 'template',
      }
      rows.push(row)
      faculty.set(row, get(r, 'faculty') || null)
    }
  }

  const batch = { program: null, branch: null, semester: null }
  return {
    sheet: ws.name,
    title: `${ws.name} (Slate template)`,
    batch,
    needsSection: false,
    legend: {},
    rollRanges: [],
    rows: rows.map((row) => {
      const { longEndTime: _, ...r } = row
      return { ...r, ...batch, faculty: faculty.get(row) ?? null }
    }),
    skipped,
    issues: validate(rows, {}),
  }
}
