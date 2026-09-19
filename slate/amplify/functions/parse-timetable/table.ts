// Non-timetable sheets (e.g. student lists): return the raw table plus a
// best guess at which column is which. The admin confirms the mapping in
// the app before anything is interpreted or saved.
import type { Worksheet } from 'exceljs'

export type ColumnGuess = {
  roll: number | null
  email: number | null
  section: number | null
  subSection: number | null
}
export type TableResult = {
  sheet: string
  kind: 'table'
  detected: 'students' | 'unknown'
  headers: string[]
  rows: string[][]
  guess: ColumnGuess
}

const MAX_ROWS = 5000
const ROLL_HEADER = /(roll|enrol|registration|reg\.?\s*no|admission\s*no|student\s*id)/i
const SECTION_HEADER = /(sec|group|batch)/i
const ROLL_VALUE = /^[A-Za-z]{2,4}\d{7}$|^\d{7}$/
const EMAIL_VALUE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const SECTION_VALUE = /^[A-Za-z]$/
const SUBSECTION_VALUE = /^[A-Za-z]\d$/

export function readTable(ws: Worksheet): TableResult {
  const text = (r: number, c: number) => (ws.getCell(r, c).text ?? '').toString().trim()
  const maxCol = ws.columnCount
  const nonEmpty = (r: number) => Array.from({ length: maxCol }, (_, i) => text(r, i + 1)).filter(Boolean).length

  // Header = first row with 2+ filled cells that's followed by data.
  let headerRow = 0
  for (let r = 1; r <= Math.min(15, ws.rowCount) && !headerRow; r++) {
    if (nonEmpty(r) >= 2 && nonEmpty(r + 1) >= 2) headerRow = r
  }
  if (!headerRow) return { sheet: ws.name, kind: 'table', detected: 'unknown', headers: [], rows: [], guess: empty() }

  const headers = Array.from({ length: maxCol }, (_, i) => text(headerRow, i + 1))
  const rows: string[][] = []
  for (let r = headerRow + 1; r <= ws.rowCount && rows.length < MAX_ROWS; r++) {
    const row = Array.from({ length: maxCol }, (_, i) => text(r, i + 1))
    if (row.some(Boolean)) rows.push(row)
  }

  const share = (c: number, re: RegExp) => {
    const vals = rows.map((r) => r[c]).filter(Boolean)
    return vals.length ? vals.filter((v) => re.test(v)).length / vals.length : 0
  }
  const distinct = (c: number) => new Set(rows.map((r) => r[c]).filter(Boolean)).size
  const pick = (headerRe: RegExp | null, valueRe: RegExp, taken: (number | null)[]) => {
    const cols = headers.map((_, c) => c).filter((c) => !taken.includes(c) && !/name/i.test(headers[c]))
    // A value-only match needs 2+ distinct values unless the header also
    // says so -- a column of one repeated letter is usually not a section.
    const byValue = cols.filter(
      (c) => share(c, valueRe) >= 0.9 && (distinct(c) >= 2 || headerRe?.test(headers[c])),
    )
    return (
      byValue.find((c) => headerRe?.test(headers[c])) ??
      byValue[0] ??
      (headerRe ? cols.find((c) => headerRe.test(headers[c]) && share(c, /\d/) >= 0.9) : undefined) ??
      null
    )
  }

  const guess = empty()
  guess.email = pick(/mail/i, EMAIL_VALUE, [])
  guess.roll = pick(ROLL_HEADER, ROLL_VALUE, [guess.email])
  guess.subSection = pick(SECTION_HEADER, SUBSECTION_VALUE, [guess.email, guess.roll])
  guess.section = pick(SECTION_HEADER, SECTION_VALUE, [guess.email, guess.roll, guess.subSection])

  // A roll/email column is enough: the admin can set one section for
  // every row when the file has no section column.
  const hasId = guess.roll !== null || guess.email !== null
  return {
    sheet: ws.name,
    kind: 'table',
    detected: hasId ? 'students' : 'unknown',
    headers,
    rows,
    guess,
  }
}

function empty(): ColumnGuess {
  return { roll: null, email: null, section: null, subSection: null }
}
