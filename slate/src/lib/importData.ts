import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../../amplify/data/resource'

const client = generateClient<Schema>()

export type ImportArgs = {
  key: string
  sheet: string
  kind: 'timetable' | 'students'
  program: string
  branch: string
  semester: number
  rollCol?: number | null
  emailCol?: number | null
  sectionCol?: number | null
  subSectionCol?: number | null
  admissionYear?: string | null
  sectionOverride?: string | null
  subSectionOverride?: string | null
  defaultSection?: string | null
  onlySections?: string[]
  removeMissing?: boolean
  dryRun: boolean
}
export type ImportResult = {
  kind: 'timetable' | 'students'
  added: number
  unchanged: number
  removed: number
  changed: { what: string; before: string; after: string }[]
  changedCount: number
  problems: { line: number; problems: string[] }[]
  problemCount?: number
  valid?: number
  counts?: Record<string, number>
  applied: boolean
}

// Same manual typing as elsewhere (Amplify type-inference workaround).
const importData = (client.mutations as unknown as {
  importData: (a: ImportArgs) => Promise<{ data: unknown; errors?: { message: string }[] }>
}).importData

/** Runs the import-data Lambda: validation, diff and (unless dryRun) the writes all happen on AWS. */
export async function runImport(args: ImportArgs): Promise<ImportResult> {
  const res = await importData(args)
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
  let payload = res.data
  while (typeof payload === 'string') payload = JSON.parse(payload)
  return payload as ImportResult
}
