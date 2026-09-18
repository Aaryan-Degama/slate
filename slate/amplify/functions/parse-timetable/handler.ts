import { Readable } from 'node:stream'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import ExcelJS from 'exceljs'
import { processSheet } from './reader'
import { readTable } from './table'

const s3 = new S3Client({})

/** Reads an uploaded file from S3 and classifies each sheet: a timetable
 * (header row of time slots) goes through read -> map -> validate; any
 * other table (e.g. a student list) comes back raw with a guessed column
 * mapping. Writes nothing -- the admin reviews and applies in the app. */
export const handler = async (event: { arguments: { key: string } }) => {
  const { key } = event.arguments
  if (!key.startsWith('timetable-uploads/')) throw new Error('key must be under timetable-uploads/')

  const obj = await s3.send(
    new GetObjectCommand({ Bucket: process.env.TIMETABLE_UPLOADS_BUCKET_NAME, Key: key }),
  )
  const bytes = Buffer.from(await obj.Body!.transformToByteArray())
  const wb = new ExcelJS.Workbook()
  if (/\.csv$/i.test(key)) await wb.csv.read(Readable.from(bytes))
  else await wb.xlsx.load(bytes as unknown as ArrayBuffer)

  const sheets = wb.worksheets.map((ws) => {
    try {
      return { kind: 'timetable' as const, ...processSheet(ws) }
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
