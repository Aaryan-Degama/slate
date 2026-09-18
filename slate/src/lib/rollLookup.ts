// Roll-number -> section resolution (CLAUDE.md §4a).
//
// Ranges live in the real RollRange table (an admin-managed dataset --
// hand-entered for now, eventually filled by an OCR-over-sheets pipeline),
// not hardcoded here. This file only does the email -> roll-number parsing
// and the range lookup against real data.
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../../amplify/data/resource'
import { listAll } from './listAll'

const client = generateClient<Schema>()

// IIITA emails look like iit<admissionYear><rollNumber>@iiita.ac.in.
const EMAIL_RE = /^iit(\d{4})(\d+)@iiita\.ac\.in$/i

type RollRangeRow = {
  admissionYear: string
  program: string
  branch: string
  semester: number
  minRoll: number
  maxRoll: number
  section: string
}
const listRollRanges = () => listAll<RollRangeRow>(client.models.RollRange.list)

export async function resolveSectionFromEmail(
  email: string,
): Promise<{ program: string; branch: string; section: string; semester: number } | null> {
  const match = email.match(EMAIL_RE)
  if (!match) return null
  const [, admissionYear, rollStr] = match
  const roll = parseInt(rollStr, 10)

  const { data: ranges } = await listRollRanges()
  const rule = ranges.find(
    (r) => r.admissionYear === admissionYear && roll >= r.minRoll && roll <= r.maxRoll,
  )
  if (!rule) return null
  return {
    program: rule.program,
    branch: rule.branch,
    section: rule.section,
    semester: rule.semester,
  }
}
