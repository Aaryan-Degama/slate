// Reads the admin's optional note on an upload ("roll numbers of section C,
// IT 2024 batch, sem 5" / "B1/B2 lab split for section B") into the same
// fields the review screen shows. Simple rules for now; Bedrock can fill
// the same fields from freer wording once the account has model quota.

export type Batch = { program: string; branch: string; semester: number }
export type NoteReading = {
  section?: string
  subSection?: string
  semester?: number
  branch?: string
  program?: string
  admissionYear?: string
  split?: boolean
  understood: string[]
}

export function interpretNote(note: string, batches: Batch[]): NoteReading {
  const out: NoteReading = { understood: [] }
  const text = note.trim()
  if (!text) return out

  const sub = /\b(?:sec(?:tion)?\s*)?([A-Z])([1-9])\b/.exec(text)
  const sec = /\bsec(?:tion)?\.?\s*([A-Za-z])\b(?!\d)/i.exec(text)
  out.split = /split|sub-?section|lab\s*group|\bB1\b|\bB2\b/i.test(text)
  // "B1/B2 split" describes the file's column, not one group for every row.
  const multipleSubs = (text.match(/\b[A-Z][1-9]\b/g) ?? []).length > 1
  if (sub && !multipleSubs) {
    out.subSection = `${sub[1]}${sub[2]}`
    out.section = sub[1]
    out.understood.push(`every row is ${out.subSection}`)
  } else if (sec) {
    out.section = sec[1].toUpperCase()
    out.understood.push(out.split ? `section ${out.section}, split into groups` : `every row is section ${out.section}`)
  }

  const sem = /\bsem(?:ester)?\.?\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s*sem/i.exec(text)
  if (sem) {
    out.semester = Number(sem[1] ?? sem[2])
    out.understood.push(`semester ${out.semester}`)
  }
  const year = /\b(20\d{2})\b/.exec(text)
  if (year) {
    out.admissionYear = year[1]
    out.understood.push(`admission year ${out.admissionYear}`)
  }
  for (const b of [...new Set(batches.map((x) => x.branch))]) {
    if (new RegExp(`\\b${b}\\b`, 'i').test(text)) {
      out.branch = b
      out.understood.push(`branch ${b}`)
      break
    }
  }
  for (const p of [...new Set(batches.map((x) => x.program))]) {
    if (new RegExp(p.replace(/(\w)(?=\w)/g, '$1\\.?\\s*'), 'i').test(text)) {
      out.program = p
      break
    }
  }
  return out
}

/** The one batch the note points at, if exactly one fits. */
export function matchBatch(reading: NoteReading, batches: Batch[]): Batch | undefined {
  const fits = batches.filter(
    (b) =>
      (reading.semester === undefined || b.semester === reading.semester) &&
      (reading.branch === undefined || b.branch === reading.branch) &&
      (reading.program === undefined || b.program === reading.program),
  )
  const saidSomething = reading.semester !== undefined || reading.branch !== undefined
  return saidSomething && fits.length === 1 ? fits[0] : undefined
}
