import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import ExcelJS from 'exceljs'
import { processSheet } from './reader'

const s3 = new S3Client({})

/** Reads an uploaded timetable from S3 and returns, per sheet, the rows
 * it would store plus everything the validator flagged. Writes nothing:
 * the admin reviews the result and applies it from the app. */
export const handler = async (event: { arguments: { key: string } }) => {
  const { key } = event.arguments
  if (!key.startsWith('timetable-uploads/')) throw new Error('key must be under timetable-uploads/')

  const obj = await s3.send(
    new GetObjectCommand({ Bucket: process.env.TIMETABLE_UPLOADS_BUCKET_NAME, Key: key }),
  )
  const bytes = await obj.Body!.transformToByteArray()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)

  const sheets = wb.worksheets.map((ws) => {
    try {
      return processSheet(ws)
    } catch (err) {
      return { sheet: ws.name, error: err instanceof Error ? err.message : String(err) }
    }
  })
  const summary = sheets.map((s) =>
    'error' in s ? `${s.sheet}: ${s.error}` : `${s.sheet}: ${s.rows.length} rows, ${s.skipped.length} skipped, ${s.issues.length} issues`,
  )
  console.log(JSON.stringify({ event: 'timetable-parsed', key, summary }))
  return JSON.stringify({ key, sheets })
}
