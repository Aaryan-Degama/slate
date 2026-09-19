import { loadWorkbook } from './load'
import { processSheet, readTemplate } from './reader'
import { readTable } from './table'

/** Reads an uploaded file from S3 and classifies each sheet: a timetable
 * (header row of time slots) goes through read -> map -> validate; any
 * other table (e.g. a student list) comes back raw with a guessed column
 * mapping. Writes nothing -- import-data does that after admin review. */
export const handler = async (event: { arguments: { key: string } }) => {
  const { key } = event.arguments
  const wb = await loadWorkbook(key)

  const sheets = wb.worksheets.map((ws) => {
    try {
      return { kind: 'timetable' as const, ...(readTemplate(ws) ?? processSheet(ws)) }
    } catch {
      try {
        return readTable(ws)
      } catch (err) {
        return { sheet: ws.name, kind: 'error' as const, error: err instanceof Error ? err.message : String(err) }
      }
    }
  })
  const summary = sheets.map((s) =>
    s.kind === 'timetable'
      ? `${s.sheet}: timetable, ${s.rows.length} rows, ${s.skipped.length} skipped, ${s.issues.length} issues`
      : s.kind === 'table'
        ? `${s.sheet}: table (${s.detected}), ${s.rows.length} rows`
        : `${s.sheet}: ${s.error}`,
  )
  console.log(JSON.stringify({ event: 'upload-parsed', key, summary }))
  return JSON.stringify({ key, sheets })
}
