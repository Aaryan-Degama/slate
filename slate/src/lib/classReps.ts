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
  const [error, setError] = useState('')
  const reload = useCallback(
    () =>
      listAll<ClassRep>(client.models.ClassRep.list)
        .then(({ data }) => {
          setReps(data)
          setError('')
        })
        .catch((err) => setError(`Couldn't load class reps: ${err instanceof Error ? err.message : String(err)}`)),
    [],
  )
  useEffect(() => {
    reload()
  }, [reload])
  return { reps, reload, error }
}

type Result = Promise<{ errors?: { message: string }[] }>
type Times = { date: string; startTime: string; endTime: string; room?: string | null }
const m = client.mutations as unknown as {
  claimCr: () => Result
  cancelOccurrence: (a: { meetingId: string; date: string }) => Result
  addExtra: (a: Times & { offeringKey: string }) => Result
  moveOccurrence: (a: Times & { meetingId: string; fromDate: string }) => Result
  undoChange: (a: { groupId: string }) => Result
}
const call = async (p: Result) => {
  const res = await p
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
}

export const claimCr = () => call(m.claimCr())
export const cancelOccurrence = (meetingId: string, date: string) => call(m.cancelOccurrence({ meetingId, date }))
export const addExtra = (a: Parameters<typeof m.addExtra>[0]) => call(m.addExtra(a))
export const moveOccurrence = (a: Parameters<typeof m.moveOccurrence>[0]) => call(m.moveOccurrence(a))
export const undoChange = (groupId: string) => call(m.undoChange({ groupId }))
export const revokeCr = (id: string) =>
  call((client.models.ClassRep.delete as unknown as (a: { id: string }) => Result)({ id }))
