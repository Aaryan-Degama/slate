type Page<T> = { data: T[]; nextToken?: string | null; errors?: { message: string }[] }

/** A model's .list() returns one page (100 items by default, and auth
 * filters apply after the page is read), so follow nextToken to the end. */
export async function listAll<T>(list: unknown): Promise<{ data: T[] }> {
  const fn = list as (o: { limit: number; nextToken?: string | null }) => Promise<Page<T>>
  const data: T[] = []
  let nextToken: string | null | undefined = null
  do {
    const page: Page<T> = await fn({ limit: 1000, nextToken })
    if (page.errors?.length) throw new Error(page.errors.map((e) => e.message).join('; '))
    data.push(...page.data)
    nextToken = page.nextToken
  } while (nextToken)
  return { data }
}
