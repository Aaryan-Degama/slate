// Roll-number -> section resolution (CLAUDE.md §4a), from admin-provided
// data only: the per-student StudentSection list first, then RollRange
// ranges as a fallback. The student list is admin-only, so the lookup runs
// on the server (section-changes Lambda, mySection) from the caller's
// verified email.
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../../amplify/data/resource'
import type { Attended } from '../../amplify/functions/shared/attendance'

const client = generateClient<Schema>()

export type ResolvedSection = {
  program: string
  branch: string
  semester: number
  section: string
  /** B1/B2-style group, when the batch splits and it's known. */
  subSection?: string
  /** Exactly which classes this student attends (home section + enrollment exceptions). */
  attends?: Attended
}

type Query = () => Promise<{ data: unknown; errors?: { message: string }[] }>
const q = client.queries as unknown as { mySection: Query; batchRoster: Query }

async function run<T>(fn: Query): Promise<T | null> {
  const res = await fn()
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
  let payload = res.data
  while (typeof payload === 'string') payload = JSON.parse(payload)
  return (payload ?? null) as T | null
}

/** The signed-in student's section. (`email` is kept for callers; the server uses the verified one.) */
export async function resolveSectionFromEmail(_email: string): Promise<ResolvedSection | null> {
  return run<ResolvedSection>(q.mySection)
}

export type BatchRoster = {
  program: string
  branch: string
  semester: number
  /** e.g. "C" or "B (B1)" */
  me: string
  /** The signed-in student's own roll id, e.g. "IIT2024245". */
  meRollId: string
  sections: {
    section: string
    cr: { email: string; since: string } | null
    students: { id: string; name: string | null; subSection: string | null }[]
    ranges: { section: string; admissionYear: string; minRoll: number; maxRoll: number }[]
  }[]
}

/** Every section of the signed-in student's own batch (never another batch). */
export const fetchBatchRoster = () => run<BatchRoster>(q.batchRoster)
