import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import { fetchUserAttributes } from 'aws-amplify/auth'
import type { Schema } from '../../amplify/data/resource'
import { listAll } from './listAll'

const client = generateClient<Schema>()

// Same generated-type workaround as NewRequest.tsx (see NOTES.md §15).
export type Profile = {
  id: string
  email: string
  role: 'STUDENT' | 'FACULTY' | 'ADMIN'
  linkedSection: { program: string; branch: string; section: string; semester: number } | null
  linkedFacultyName: string | null
}
// AWSJSON (linkedSection's real GraphQL type) travels over the wire as a
// *string*; the normal generated client auto-(de)serializes it, but our
// manually-cast calls bypass that, so we do it by hand on both ends.
type RawProfile = Omit<Profile, 'linkedSection'> & { linkedSection: string | object | null; owner?: string | null }

function normalize(raw: RawProfile | null): Profile | null {
  if (!raw) return null
  let linkedSection = raw.linkedSection
  if (typeof linkedSection === 'string' && linkedSection.length > 0) {
    linkedSection = JSON.parse(linkedSection)
  }
  return { ...raw, linkedSection: linkedSection as Profile['linkedSection'] }
}

const listMyUsers = () => listAll<RawProfile>(client.models.User.list)
const createUser = client.models.User.create as unknown as (input: {
  email: string
  role: 'STUDENT' | 'FACULTY' | 'ADMIN'
}) => Promise<{ data: RawProfile | null; errors?: { message: string }[] }>
const updateUser = client.models.User.update as unknown as (
  input: { id: string; linkedSection?: string; linkedFacultyName?: string },
) => Promise<{ data: RawProfile | null; errors?: { message: string }[] }>

/** Every signed-in user can read all User rows, so pick our own by the
 * owner field (Cognito sub, stored as "<sub>::<username>"). */
export function useMyProfile(userId: string) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await listMyUsers()
      const mine = all.data.filter((u) => u.owner === userId || u.owner?.startsWith(`${userId}::`))
      if (mine.length > 0) {
        if (!cancelled) setProfile(normalize(mine[0]))
      } else {
        const attrs = await fetchUserAttributes()
        const created = await createUser({
          email: attrs.email ?? '',
          role: 'STUDENT',
        })
        if (created.errors?.length) throw new Error(created.errors.map((e) => e.message).join('; '))
        if (!cancelled) setProfile(normalize(created.data))
      }
      if (!cancelled) setLoading(false)
    }
    load().catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  const linkSection = async (section: {
    program: string
    branch: string
    section: string
    semester: number
  }) => {
    if (!profile) return
    const updated = await updateUser({ id: profile.id, linkedSection: JSON.stringify(section) })
    if (updated.errors?.length) {
      throw new Error(updated.errors.map((e) => e.message).join('; '))
    }
    const normalized = normalize(updated.data)
    if (normalized) setProfile(normalized)
  }

  const linkFacultyName = async (name: string) => {
    if (!profile) return
    const updated = await updateUser({ id: profile.id, linkedFacultyName: name })
    if (updated.errors?.length) {
      throw new Error(updated.errors.map((e) => e.message).join('; '))
    }
    const normalized = normalize(updated.data)
    if (normalized) setProfile(normalized)
  }

  return { profile, loading, error, linkSection, linkFacultyName }
}
