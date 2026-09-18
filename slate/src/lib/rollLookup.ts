// Roll-number -> section resolution (CLAUDE.md §4a).
//
// In the intended design an admin uploads this mapping (a real
// roll-number-to-section sheet); there's no admin upload screen yet, so
// for now it's hand-entered here from data given directly by the team,
// the same way the timetable itself was hand-structured (see NOTES.md).
// Nothing here is guessed — ranges not yet provided (e.g. IEC) are simply
// left out, and resolution falls back to the manual picker for anyone
// not covered.
//
// IIITA emails look like iit<admissionYear><rollNumber>@iiita.ac.in.
const EMAIL_RE = /^iit(\d{4})(\d+)@iiita\.ac\.in$/i

type RangeRule = {
  admissionYear: string // matches the year embedded in the email
  semester: number
  program: string
  branch: string
  min: number
  max: number
  section: string
}

// Batch admitted 2024 (graduating 2028), currently 5th semester.
const ROLL_RANGES: RangeRule[] = [
  { admissionYear: '2024', semester: 5, program: 'BTech', branch: 'IT', min: 1, max: 107, section: 'A' },
  { admissionYear: '2024', semester: 5, program: 'BTech', branch: 'IT', min: 108, max: 214, section: 'B' },
  { admissionYear: '2024', semester: 5, program: 'BTech', branch: 'IT', min: 215, max: 276, section: 'C' },
  // IEC roll range not yet provided -- add here once known, same shape
  // as above. Until then, IEC students land on the manual picker.
]

export function resolveSectionFromEmail(
  email: string,
): { program: string; branch: string; section: string; semester: number } | null {
  const match = email.match(EMAIL_RE)
  if (!match) return null
  const [, admissionYear, rollStr] = match
  const roll = parseInt(rollStr, 10)
  const rule = ROLL_RANGES.find(
    (r) => r.admissionYear === admissionYear && roll >= r.min && roll <= r.max,
  )
  if (!rule) return null
  return {
    program: rule.program,
    branch: rule.branch,
    section: rule.section,
    semester: rule.semester,
  }
}
