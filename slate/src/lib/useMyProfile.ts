import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import { fetchUserAttributes } from 'aws-amplify/auth'
import type { Schema } from '../../amplify/data/resource'

const client = generateClient<Schema>()

// Same generated-type workaround as NewRequest.tsx (see NOTES.md §15).
export type Profile = {
  id: string
  email: string
  role: 'STUDENT' | 'FACULTY' | 'ADMIN'
  linkedSection: { program: string; branch: string; section: string; semester: number } | null
  linkedFacultyName: string | null
}
const listMyUsers = client.models.User.list as unknown as () => Promise<{ data: Profile[] }>
const createUser = client.models.User.create as unknown as (input: {
  email: string
  role: 'STUDENT' | 'FACULTY' | 'ADMIN'
}) => Promise<{ data: Profile | null }>
const updateUser = client.models.User.update as unknown as (
  input: { id: string } & Partial<Pick<Profile, 'linkedSection' | 'linkedFacultyName'>>,
) => Promise<{ data: Profile | null }>

/** Owner-scoped: list() only ever returns the signed-in user's own rows. */
export function useMyProfile() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const existing = await listMyUsers()
      if (existing.data.length > 0) {
        if (!cancelled) setProfile(existing.data[0])
      } else {
        const attrs = await fetchUserAttributes()
        const created = await createUser({
          email: attrs.email ?? '',
          role: 'STUDENT',
        })
        if (!cancelled) setProfile(created.data)
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const linkSection = async (section: {
    program: string
    branch: string
    section: string
    semester: number
  }) => {
    if (!profile) return
    const updated = await updateUser({ id: profile.id, linkedSection: section })
    if (updated.data) setProfile(updated.data)
  }

  const linkFacultyName = async (name: string) => {
    if (!profile) return
    const updated = await updateUser({ id: profile.id, linkedFacultyName: name })
    if (updated.data) setProfile(updated.data)
  }

  return { profile, loading, linkSection, linkFacultyName }
}
