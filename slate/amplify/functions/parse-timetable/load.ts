import { Readable } from 'node:stream'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import ExcelJS from 'exceljs'

const s3 = new S3Client({})

/** Loads an uploaded .xlsx/.csv from the uploads bucket. */
export async function loadWorkbook(key: string) {
  if (!key.startsWith('timetable-uploads/')) throw new Error('key must be under timetable-uploads/')
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: process.env.TIMETABLE_UPLOADS_BUCKET_NAME, Key: key }),
  )
  const bytes = Buffer.from(await obj.Body!.transformToByteArray())
  const wb = new ExcelJS.Workbook()
  if (/\.csv$/i.test(key)) await wb.csv.read(Readable.from(bytes))
  else await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  return wb
}
