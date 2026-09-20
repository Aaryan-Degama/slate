import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { loadWorkbook } from '../parse-timetable/load'
import { processSheet, readTemplate, WHOLE_BATCH } from '../parse-timetable/reader'
import { readTable } from '../parse-timetable/table'
import { buildStudentRecords } from './students'

type Args = {
  key: string
  sheet: string
  kind: string
  program: string
  branch: string
  semester: number
  rollCol?: number | null
  emailCol?: number | null
  nameCol?: number | null
  sectionCol?: number | null
  subSectionCol?: number | null
  admissionYear?: string | null
  sectionOverride?: string | null
  subSectionOverride?: string | null
  defaultSection?: string | null
  onlySections?: (string | null)[] | null
  removeMissing?: boolean | null
  dryRun: boolean
}
type Event = { arguments: Args; identity?: { groups?: string[] | null; username?: string } | null }
type Item = Record<string, unknown> & { id: string }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
const TT = process.env.TIMETABLE_SLOT_TABLE!
const SS = process.env.STUDENT_SECTION_TABLE!
const RR = process.env.ROLL_RANGE_TABLE!

async function scanAll(table: string): Promise<Item[]> {
  const items: Item[] = []
  let start: Record<string, unknown> | undefined
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }))
    items.push(...((page.Items ?? []) as Item[]))
    start = page.LastEvaluatedKey
  } while (start)
  return items
}

async function batchWrite(table: string, requests: Record<string, unknown>[]) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: Record<string, unknown>[] | undefined = requests.slice(i, i + 25)
    for (let attempt = 0; pending?.length && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: pending as never } }))
      pending = res.UnprocessedItems?.[table] as Record<string, unknown>[] | undefined
      if (pending?.length) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
    }
    if (pending?.length) throw new Error(`${pending.length} writes to ${table} were not processed`)
  }
}

const now = () => new Date().toISOString()
const newItem = (typename: string, fields: Record<string, unknown>) => {
  const t = now()
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined))
  return { PutRequest: { Item: { id: randomUUID(), __typename: typename, createdAt: t, updatedAt: t, ...clean } } }
}
const del = (id: string) => ({ DeleteRequest: { Key: { id } } })

async function update(table: string, id: string, fields: Record<string, unknown>) {
  const set = { ...fields, updatedAt: now() }
  const names = Object.keys(set)
  const nulls = names.filter((n) => set[n as keyof typeof set] === null || set[n as keyof typeof set] === undefined)
  const values = names.filter((n) => !nulls.includes(n))
  const expr = [
    values.length ? `SET ${values.map((n) => `#${n} = :${n}`).join(', ')}` : '',
    nulls.length ? `REMOVE ${nulls.map((n) => `#${n}`).join(', ')}` : '',
  ].join(' ')
  await ddb.send(
    new UpdateCommand({
      TableName: table,
      Key: { id },
      UpdateExpression: expr.trim(),
      ExpressionAttributeNames: Object.fromEntries(names.map((n) => [`#${n}`, n])),
      ExpressionAttributeValues: values.length
        ? Object.fromEntries(values.map((n) => [`:${n}`, set[n as keyof typeof set]]))
        : undefined,
    }),
  )
}

export const handler = async (event: Event) => {
  if (!event.identity?.groups?.includes('ADMIN')) throw new Error('Only admins can import data.')
  const a = event.arguments
  const batch = { program: a.program, branch: a.branch, semester: a.semester }
  const inBatch = (i: Item) => i.program === batch.program && i.branch === batch.branch && Number(i.semester) === batch.semester

  const wb = await loadWorkbook(a.key)
  const ws = wb.worksheets.find((w) => w.name === a.sheet)
  if (!ws) throw new Error(`sheet "${a.sheet}" not found in ${a.key}`)

  let result: Record<string, unknown>

  if (a.kind === 'timetable') {
    const parsed = readTemplate(ws) ?? processSheet(ws)
    const whole = a.defaultSection?.trim().toUpperCase()
    if (parsed.needsSection && !(whole && /^[A-Z]$/.test(whole)))
      throw new Error("This sheet's classes don't name a section. Say which section the batch is (e.g. D).")
    const only = (a.onlySections ?? []).filter((x): x is string => !!x).map((x) => x.trim().toUpperCase())
    const rows = parsed.rows
      // Electives keep section '*' (the whole batch is offered them; who
      // attends comes from Enrollment), so a section filter never drops them.
      .filter((r) => r.isElective || !only.length || only.includes(r.section === WHOLE_BATCH ? whole! : r.section))
      .map((r) => ({
      ...batch,
      day: r.day,
      startTime: r.startTime,
      endTime: r.endTime,
      courseId: r.courseId,
      sessionType: r.sessionType,
      section: r.isElective || r.section !== WHOLE_BATCH ? r.section : whole!,
      room: r.room || undefined,
      faculty: r.faculty,
      isElective: r.isElective || undefined,
    }))
    const key = (r: Record<string, unknown>) => `${r.day}|${r.courseId}|${r.sessionType ?? ''}|${r.section}|${r.startTime}`
    const existing = (await scanAll(TT)).filter(inBatch)
    const byKey = new Map(existing.map((e) => [key(e), e]))
    const seen = new Set(rows.map(key))
    const added = rows.filter((r) => !byKey.has(key(r)))
    const changed = rows.flatMap((r) => {
      const cur = byKey.get(key(r))
      if (!cur) return []
      const fields = (['endTime', 'room', 'faculty', 'isElective'] as const).filter((f) => (cur[f] ?? null) !== (r[f] ?? null))
      return fields.length ? [{ cur, next: r, fields }] : []
    })
    const removed = existing.filter((e) => !seen.has(key(e)))

    // Roll ranges printed in the sheet, for the sections imported here and
    // this batch's branch (roll prefix IIT -> IT, IEC -> EC).
    const importedSections = new Set(rows.map((r) => r.section))
    const sheetRanges = parsed.rollRanges.filter(
      (x) => importedSections.has(x.section) && x.prefix.slice(1) === batch.branch.toUpperCase(),
    )
    const currentRanges = (await scanAll(RR)).filter(inBatch)
    const rangeChanges = sheetRanges.map((x) => {
      const cur = currentRanges.find((c) => c.admissionYear === x.admissionYear && c.section === x.section)
      const status = !cur ? 'new' : Number(cur.minRoll) === x.minRoll && Number(cur.maxRoll) === x.maxRoll ? 'same' : 'changed'
      return { ...x, status, id: cur?.id }
    })

    if (!a.dryRun) {
      await batchWrite(TT, added.map((r) => newItem('TimetableSlot', r)))
      for (const c of changed) await update(TT, c.cur.id, { endTime: c.next.endTime, room: c.next.room, faculty: c.next.faculty })
      if (a.removeMissing) await batchWrite(TT, removed.map((e) => del(e.id)))
      await batchWrite(
        RR,
        rangeChanges
          .filter((x) => x.status === 'new')
          .map((x) =>
            newItem('RollRange', { ...batch, admissionYear: x.admissionYear, section: x.section, minRoll: x.minRoll, maxRoll: x.maxRoll }),
          ),
      )
      for (const x of rangeChanges.filter((x) => x.status === 'changed'))
        await update(RR, x.id!, { minRoll: x.minRoll, maxRoll: x.maxRoll })
    }
    result = {
      kind: 'timetable',
      added: added.length,
      unchanged: rows.length - added.length - changed.length,
      removed: removed.length,
      changed: changed.slice(0, 100).map((c) => ({
        what: `${c.next.courseId} (${c.next.sessionType}) Sec ${c.next.section} ${c.next.day} ${c.next.startTime}`,
        before: c.fields.map((f) => `${f}: ${c.cur[f] ?? '—'}`).join(', '),
        after: c.fields.map((f) => `${f}: ${c.next[f] ?? '—'}`).join(', '),
      })),
      changedCount: changed.length,
      problems: [],
      rollRanges: rangeChanges.map(({ id: _, ...x }) => x),
    }
  } else if (a.kind === 'students') {
    const table = readTable(ws)
    const mapping = {
      roll: a.rollCol ?? null,
      email: a.emailCol ?? null,
      name: a.nameCol ?? null,
      section: a.sectionCol ?? null,
      subSection: a.subSectionCol ?? null,
    }
    const batchSections = [...new Set((await scanAll(TT)).filter(inBatch).map((s) => String(s.section)))]
    const records = buildStudentRecords(table.rows, mapping, batchSections, a.admissionYear ?? undefined, {
      section: a.sectionOverride ?? undefined,
      subSection: a.subSectionOverride ?? undefined,
    })
    // Roll numbers restart per prefix and a batch can mix them (IT Sem 5
    // holds IIT and IIB students), so a student is identified by
    // prefix + year + number. Rows imported before prefixes were kept fall
    // back to the batch's branch (IIT for an IT batch).
    const fallback = `I${batch.branch.toUpperCase()}`
    const idOf = (prefix: string | undefined, year: string | undefined, roll: number | undefined) =>
      `${(prefix || fallback).toUpperCase()}|${year}|${roll}`
    const valid = [...new Map(records.filter((r) => !r.problems.length).map((r) => [idOf(r.prefix, r.year, r.roll), r])).values()]

    const existing = (await scanAll(SS)).filter(inBatch)
    const byKey = new Map(existing.map((e) => [idOf(e.rollPrefix as string | undefined, String(e.admissionYear), Number(e.rollNumber)), e]))
    const seen = new Set(valid.map((r) => idOf(r.prefix, r.year, r.roll)))
    const setsSub = mapping.subSection !== null
    const added = valid.filter((r) => !byKey.has(idOf(r.prefix, r.year, r.roll)))
    const changed = valid.flatMap((r) => {
      const cur = byKey.get(idOf(r.prefix, r.year, r.roll))
      if (!cur) return []
      const differs =
        cur.section !== r.section ||
        (setsSub && (cur.subSection ?? undefined) !== r.subSection) ||
        (mapping.name !== null && (cur.name ?? undefined) !== r.name)
      return differs ? [{ cur, next: r }] : []
    })
    const removed = existing.filter((e) => !seen.has(idOf(e.rollPrefix as string | undefined, String(e.admissionYear), Number(e.rollNumber))))

    if (!a.dryRun) {
      await batchWrite(
        SS,
        added.map((r) =>
          newItem('StudentSection', {
            ...batch,
            admissionYear: r.year,
            rollNumber: r.roll,
            rollPrefix: r.prefix,
            name: r.name,
            section: r.section,
            subSection: r.subSection,
          }),
        ),
      )
      for (const c of changed)
        await update(SS, c.cur.id, {
          section: c.next.section,
          ...(setsSub ? { subSection: c.next.subSection ?? null } : {}),
          ...(mapping.name !== null ? { name: c.next.name ?? null } : {}),
        })
      if (a.removeMissing) await batchWrite(SS, removed.map((e) => del(e.id)))
    }
    const counts: Record<string, number> = {}
    for (const r of valid) counts[r.subSection ?? r.section!] = (counts[r.subSection ?? r.section!] ?? 0) + 1
    result = {
      kind: 'students',
      valid: valid.length,
      counts,
      added: added.length,
      unchanged: valid.length - added.length - changed.length,
      removed: removed.length,
      changed: changed.slice(0, 100).map((c) => ({
        what: `${c.cur.admissionYear} / ${c.cur.rollNumber}`,
        before: String(c.cur.subSection ?? c.cur.section),
        after: String(c.next.subSection ?? c.next.section),
      })),
      changedCount: changed.length,
      problems: records
        .filter((r) => r.problems.length)
        .slice(0, 200)
        .map((r) => ({ line: r.line, problems: r.problems })),
      problemCount: records.filter((r) => r.problems.length).length,
    }
  } else {
    throw new Error(`unknown kind "${a.kind}"`)
  }

  result.applied = !a.dryRun
  console.log(
    JSON.stringify({
      event: a.dryRun ? 'import-checked' : 'import-applied',
      by: event.identity?.username,
      key: a.key,
      sheet: a.sheet,
      batch,
      added: result.added,
      changed: result.changedCount,
      removed: a.removeMissing ? result.removed : 0,
    }),
  )
  return JSON.stringify(result)
}
