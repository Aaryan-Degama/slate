// Roll-number -> section resolution (CLAUDE.md §4a), from admin-provided
// data only: the per-student StudentSection list first, then RollRange
// ranges as a fallback.
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../../amplify/data/resource'
import { listAll } from './listAll'

const client = generateClient<Schema>()

// IIITA emails look like iit<admissionYear><rollNumber>@iiita.ac.in.
const EMAIL_RE = /^([a-z]{2,4})(\d{4})(\d+)@iiita\.ac\.in$/i

export type ResolvedSection = {
  program: string
  branch: string
  semester: number
  section: string
  /** B1/B2-style group, when the batch splits and it's known. */
  subSection?: string
}

type RollRangeRow = {
  admissionYear: string
  program: string
  branch: string
  semester: number
  minRoll: number
  maxRoll: number
  section: string
}
type StudentSectionRow = {
  admissionYear: string
  rollNumber: number
  program: string
  branch: string
  semester: number
  section: string
  subSection?: string | null
}
const listRollRanges = () => listAll<RollRangeRow>(client.models.RollRange.list)
const listStudentSections = () => listAll<StudentSectionRow>(client.models.StudentSection.list)

const isSub = (s: string) => /^[A-Z]\d$/i.test(s)

export async function resolveSectionFromEmail(email: string): Promise<ResolvedSection | null> {
  const match = email.match(EMAIL_RE)
  if (!match) return null
  const [, prefix, admissionYear, rollStr] = match
  const roll = parseInt(rollStr, 10)
  // Roll numbers restart per branch (IIT2026001 and IEC2026001 both exist),
  // so the prefix picks the branch: IIT -> IT, IEC -> EC.
  const branch = prefix.slice(1).toUpperCase()
  const sameBranch = <T extends { branch: string }>(rows: T[]) => rows.filter((r) => r.branch.toUpperCase() === branch)

  const { data: students } = await listStudentSections()
  const mine = sameBranch(students)
    .filter((s) => s.admissionYear === admissionYear && s.rollNumber === roll)
    .sort((a, b) => b.semester - a.semester)[0]
  if (mine) {
    return {
      program: mine.program,
      branch: mine.branch,
      semester: mine.semester,
      section: mine.section,
      subSection: mine.subSection ?? undefined,
    }
  }

  const { data: ranges } = await listRollRanges()
  const hits = sameBranch(ranges).filter((r) => r.admissionYear === admissionYear && roll >= r.minRoll && roll <= r.maxRoll)
  const whole = hits.find((r) => !isSub(r.section))
  const sub = hits.find((r) => isSub(r.section))
  const base = whole ?? sub
  if (!base) return null
  return {
    program: base.program,
    branch: base.branch,
    semester: base.semester,
    section: whole ? whole.section : sub!.section[0],
    subSection: sub?.section,
  }
}
