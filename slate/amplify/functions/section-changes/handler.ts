// Every change to a section's timetable after ingestion goes through here,
// and every one is decided by the Cedar policy in policy.cedar:
// - claimCr:      become your section's class representative (CR)
// - addClass:     CR adds a one-off class to their section
// - cancelClass:  CR cancels a regular class of their section
// - undoChange:   CR removes an added class / restores a cancelled one
// Each ScheduleChange records who made it (changedBy), so every change on
// a timetable is traceable to a person.
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { initSync, isAuthorized, type CedarValueJson } from '@cedar-policy/cedar-wasm/web'
import { CEDAR_WASM_BASE64, POLICY } from './embedded.gen'

initSync({ module: Buffer.from(CEDAR_WASM_BASE64, 'base64') })

type Identity = { sub: string; groups?: string[] | null; claims?: { email?: string } }
// Amplify's function resolver puts fieldName at the top level; a plain
// AppSync Lambda resolver puts it under info. Accept both.
type Event = { fieldName?: string; info?: { fieldName: string }; arguments: Record<string, unknown>; identity: Identity }
type Row = Record<string, unknown>
type Section = { program: string; branch: string; semester: number; section: string }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const env = (k: string) => process.env[k]!
const [SC, TT, CR, SS, RR] = ['SCHEDULE_CHANGE_TABLE', 'TIMETABLE_SLOT_TABLE', 'CLASS_REP_TABLE', 'STUDENT_SECTION_TABLE', 'ROLL_RANGE_TABLE'].map(env)

async function scanAll(table: string): Promise<Row[]> {
  const items: Row[] = []
  let start: Record<string, unknown> | undefined
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }))
    items.push(...((page.Items ?? []) as Row[]))
    start = page.LastEvaluatedKey
  } while (start)
  return items
}

/** Sections are keyed by their main section: a B1/B2 class belongs to B's CR. */
const keyOf = (s: Row) =>
  `${s.program}|${s.branch}|${s.semester}|${String(s.section)[0]}`

// IIITA emails look like iit<admissionYear><rollNumber>@iiita.ac.in; the
// prefix picks the branch (IIT -> IT, IEC -> EC). Same rules as
// src/lib/rollLookup.ts, but server-side so the section can be trusted.
const EMAIL_RE = /^([a-z]{2,4})(\d{4})(\d+)@iiita\.ac\.in$/i
async function sectionOf(email: string): Promise<Section | null> {
  const m = email.match(EMAIL_RE)
  if (!m) return null
  const [, prefix, year, rollStr] = m
  const roll = parseInt(rollStr, 10)
  const branch = prefix.slice(1).toUpperCase()
  const ok = (r: Row) => String(r.branch).toUpperCase() === branch && r.admissionYear === year
  const student = (await scanAll(SS))
    .filter((r) => ok(r) && Number(r.rollNumber) === roll)
    .sort((a, b) => Number(b.semester) - Number(a.semester))[0]
  const hit = student ?? (await scanAll(RR)).find((r) => ok(r) && roll >= Number(r.minRoll) && roll <= Number(r.maxRoll))
  if (!hit) return null
  return { program: String(hit.program), branch: String(hit.branch), semester: Number(hit.semester), section: String(hit.section)[0] }
}

const roleOf = (groups: string[]) => (groups.includes('ADMIN') ? 'ADMIN' : 'STUDENT')

/** Ask Cedar; throws with `denied` unless the policy allows it. Every decision is logged. */
async function authorize(action: string, identity: Identity, key: string, denied: string) {
  const email = identity.claims?.email ?? ''
  const mine = await sectionOf(email)
  const reps = await scanAll(CR)
  const rep = reps.find((r) => r.sectionKey === key)
  const user = { type: 'Slate::User', id: identity.sub }
  const principal = { uid: user, attrs: { role: roleOf(identity.groups ?? []), section: mine ? keyOf(mine) : '' }, parents: [] }
  const resourceAttrs: Record<string, CedarValueJson> = { key, hasCr: Boolean(rep) }
  if (rep) resourceAttrs.cr = { __entity: { type: 'Slate::User', id: String(rep.sub) } }
  const resource = { uid: { type: 'Slate::Section', id: key }, attrs: resourceAttrs, parents: [] }
  const answer = isAuthorized({
    principal: user,
    action: { type: 'Slate::Action', id: action },
    resource: resource.uid,
    context: {},
    policies: { staticPolicies: POLICY },
    entities: [principal, resource],
  })
  if (answer.type === 'failure') throw new Error(`Cedar error: ${answer.errors.map((e) => e.message).join('; ')}`)
  const decision = answer.response.decision
  console.log(JSON.stringify({ cedar: decision, action, email, principal: principal.attrs, section: key, cr: rep?.email ?? null }))
  if (decision !== 'allow') throw new Error(denied)
  return { email, mine, rep }
}

async function writeChanges(rows: Row[]) {
  for (let i = 0; i < rows.length; i += 25)
    await ddb.send(new BatchWriteCommand({ RequestItems: { [SC]: rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }))
}

const change = (fields: Row, changedBy: string) => {
  const now = new Date().toISOString()
  return { id: randomUUID(), __typename: 'ScheduleChange', ...fields, changedBy, createdAt: now, updatedAt: now }
}

export const handler = async (event: Event) => {
  const { identity } = event
  const args = event.arguments
  const field = event.fieldName ?? event.info?.fieldName
  switch (field) {
    case 'claimCr': {
      const mine = await sectionOf(identity.claims?.email ?? '')
      if (!mine) throw new Error("Your section couldn't be found from your roll number, so you can't claim CR yet.")
      const key = keyOf(mine)
      const { email } = await authorize('ClaimCr', identity, key, 'Your section already has a CR.')
      const now = new Date().toISOString()
      await ddb.send(
        new PutCommand({
          TableName: CR,
          Item: { id: randomUUID(), __typename: 'ClassRep', sectionKey: key, ...mine, sub: identity.sub, email, createdAt: now, updatedAt: now },
        }),
      )
      return JSON.stringify({ claimed: key })
    }

    case 'addClass': {
      const mine = await sectionOf(identity.claims?.email ?? '')
      if (!mine) throw new Error("Your section couldn't be found from your roll number.")
      const { email } = await authorize('AddClass', identity, keyOf(mine), "Only your section's CR can add classes.")
      const { day, startTime, endTime, room, purpose } = args as Record<string, string | null>
      await writeChanges([
        change({ ...mine, day, startTime, endTime, courseId: purpose, ...(room ? { room } : {}), changeType: 'SCHEDULED' }, email),
      ])
      return JSON.stringify({ added: 1 })
    }

    case 'cancelClass': {
      const rows: Row[] = []
      for (const id of args.slotIds as string[]) {
        const slot = (await ddb.send(new GetCommand({ TableName: TT, Key: { id } }))).Item
        if (!slot) throw new Error('No such class.')
        const { email } = await authorize('CancelClass', identity, keyOf(slot), "Only this section's CR can cancel its classes.")
        const { program, branch, semester, section, day, startTime, endTime, courseId, room } = slot
        rows.push(
          change({ relatedSlotId: id, program, branch, semester, section, day, startTime, endTime, courseId, ...(room ? { room } : {}), changeType: 'CANCELLED' }, email),
        )
      }
      await writeChanges(rows)
      return JSON.stringify({ cancelled: rows.length })
    }

    case 'undoChange': {
      const id = args.changeId as string
      const row = (await ddb.send(new GetCommand({ TableName: SC, Key: { id } }))).Item
      if (!row || row.undoneAt) throw new Error('No such change.')
      const { email } = await authorize('UndoChange', identity, keyOf(row), "Only this section's CR can undo its changes.")
      // Kept, not deleted: the history still shows who made it and who undid it.
      const now = new Date().toISOString()
      await ddb.send(
        new UpdateCommand({
          TableName: SC,
          Key: { id },
          UpdateExpression: 'SET undoneBy = :by, undoneAt = :now, updatedAt = :now',
          ExpressionAttributeValues: { ':by': email, ':now': now },
        }),
      )
      return JSON.stringify({ undone: id })
    }
  }
  throw new Error(`Unknown field ${field}`)
}
