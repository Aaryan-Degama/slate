// Class representatives (one per section) and the four timetable-change
// mutations. The section-changes Lambda + Cedar policy decide everything;
// these are thin wrappers.
import { useCallback, useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../../amplify/data/resource'
import { listAll } from './listAll'

const client = generateClient<Schema>()

export type ClassRep = {
  id: string
  sectionKey: string
  program: string
  branch: string
  semester: number
  section: string
  sub: string
  email: string
  createdAt: string
}

/** Same key the Lambda uses: B1/B2 belong to section B. */
export const sectionKey = (s: { program: string; branch: string; semester: number; section: string }) =>
  `${s.program}|${s.branch}|${s.semester}|${s.section[0]}`

export function useClassReps() {
  const [reps, setReps] = useState<ClassRep[] | null>(null)
  const reload = useCallback(
    () => listAll<ClassRep>(client.models.ClassRep.list).then(({ data }) => setReps(data)),
    [],
  )
  useEffect(() => {
    reload()
  }, [reload])
  return { reps, reload }
}

type Result = Promise<{ errors?: { message: string }[] }>
const m = client.mutations as unknown as {
  claimCr: () => Result
  addClass: (a: { day: string; startTime: string; endTime: string; room?: string | null; purpose: string }) => Result
  cancelClass: (a: { slotIds: string[] }) => Result
  undoChange: (a: { changeId: string }) => Result
}
const call = async (p: Result) => {
  const res = await p
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
}

export const claimCr = () => call(m.claimCr())
export const addClass = (a: Parameters<typeof m.addClass>[0]) => call(m.addClass(a))
export const cancelClass = (slotIds: string[]) => call(m.cancelClass({ slotIds }))
export const undoChange = (changeId: string) => call(m.undoChange({ changeId }))
export const revokeCr = (id: string) =>
  call((client.models.ClassRep.delete as unknown as (a: { id: string }) => Result)({ id }))
