// The only two ways the timetable changes after ingestion, both decided by
// the Cedar policy in confirm.cedar:
// - confirmSlot (CLAUDE.md §2 screen 3): writes one SCHEDULED change per
//   section of the request and marks it CONFIRMED.
// - cancelClass: writes one CANCELLED change per section of a regular class.
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { initSync, isAuthorized, type CedarValueJson } from '@cedar-policy/cedar-wasm/web'
import { CEDAR_WASM_BASE64, POLICY } from './embedded.gen'

initSync({ module: Buffer.from(CEDAR_WASM_BASE64, 'base64') })

type ConfirmArgs = { requestId: string; day: string; startTime: string; endTime: string; room?: string | null; purpose: string }
type CancelArgs = { slotIds: string[] }
type Identity = { sub: string; groups?: string[] | null }
type Event =
  | { info: { fieldName: 'confirmSlot' }; arguments: ConfirmArgs; identity: Identity }
  | { info: { fieldName: 'cancelClass' }; arguments: CancelArgs; identity: Identity }
type Entity = { uid: { type: string; id: string }; attrs: Record<string, CedarValueJson>; parents: [] }
type Section = { program: string; branch: string; section: string }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const SR = process.env.SLOT_REQUEST_TABLE!
const SC = process.env.SCHEDULE_CHANGE_TABLE!
const TT = process.env.TIMETABLE_SLOT_TABLE!
const US = process.env.USER_TABLE!

// Cognito groups are the source of truth for roles (users can edit their
// own User row, not their groups).
const roleOf = (groups: string[]) =>
  groups.includes('ADMIN') ? 'ADMIN' : groups.includes('FACULTY') ? 'FACULTY' : 'STUDENT'

/** Ask Cedar; throws unless the policy allows it. Every decision is logged. */
function authorize(action: string, principal: Entity, resource: Entity) {
  const answer = isAuthorized({
    principal: principal.uid,
    action: { type: 'Slate::Action', id: action },
    resource: resource.uid,
    context: {},
    policies: { staticPolicies: POLICY },
    entities: [principal, resource],
  })
  if (answer.type === 'failure') throw new Error(`Cedar error: ${answer.errors.map((e) => e.message).join('; ')}`)
  const decision = answer.response.decision
  console.log(JSON.stringify({ cedar: decision, action, principal: principal.uid.id, attrs: principal.attrs, resource: resource.uid }))
  return decision === 'allow'
}

async function writeChanges(rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 25)
    await ddb.send(
      new BatchWriteCommand({ RequestItems: { [SC]: rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }),
    )
}

export const handler = async (event: Event) =>
  event.info.fieldName === 'cancelClass'
    ? cancelClass(event.arguments as CancelArgs, event.identity)
    : confirmSlot(event.arguments as ConfirmArgs, event.identity)

async function cancelClass({ slotIds }: CancelArgs, { sub, groups }: Identity) {
  const role = roleOf(groups ?? [])
  // The faculty name this login is linked to (CLAUDE.md §4a). The User
  // row's owner is "<sub>::<username>".
  let facultyName = ''
  let start: Record<string, unknown> | undefined
  do {
    const page = await ddb.send(new ScanCommand({ TableName: US, ExclusiveStartKey: start }))
    const me = page.Items?.find((u) => typeof u.owner === 'string' && (u.owner === sub || u.owner.startsWith(`${sub}::`)))
    if (me) facultyName = String(me.linkedFacultyName ?? '')
    start = me ? undefined : page.LastEvaluatedKey
  } while (start)
  const principal: Entity = { uid: { type: 'Slate::User', id: sub }, attrs: { role, facultyName }, parents: [] }

  const now = new Date().toISOString()
  const rows = []
  for (const id of slotIds) {
    const slot = (await ddb.send(new GetCommand({ TableName: TT, Key: { id } }))).Item
    if (!slot) throw new Error('No such class.')
    const resource: Entity = { uid: { type: 'Slate::TimetableSlot', id }, attrs: { faculty: String(slot.faculty ?? '') }, parents: [] }
    if (!authorize('Cancel', principal, resource)) throw new Error('Not authorized: only the faculty member who teaches this class can cancel it.')
    rows.push({
      id: randomUUID(),
      __typename: 'ScheduleChange',
      relatedRequestId: id,
      program: slot.program,
      branch: slot.branch,
      section: slot.section,
      day: slot.day,
      startTime: slot.startTime,
      endTime: slot.endTime,
      courseId: slot.courseId,
      ...(slot.room ? { room: slot.room } : {}),
      changeType: 'CANCELLED',
      createdAt: now,
      updatedAt: now,
    })
  }
  await writeChanges(rows)
  return JSON.stringify({ cancelled: rows.length })
}

async function confirmSlot({ requestId, day, startTime, endTime, room, purpose }: ConfirmArgs, { sub, groups }: Identity) {
  const role = roleOf(groups ?? [])
  const request = (await ddb.send(new GetCommand({ TableName: SR, Key: { id: requestId } }))).Item
  if (!request) throw new Error('No such request.')

  const allowed = authorize(
    'Confirm',
    { uid: { type: 'Slate::User', id: sub }, attrs: { role }, parents: [] },
    {
      uid: { type: 'Slate::SlotRequest', id: requestId },
      attrs: { requester: { __entity: { type: 'Slate::User', id: String(request.requesterId) } } },
      parents: [],
    },
  )
  if (!allowed) throw new Error('Not authorized: only the faculty member who raised this request can confirm it.')
  if (request.status === 'CONFIRMED') throw new Error('This request is already confirmed.')
  let sections = request.sections as unknown
  while (typeof sections === 'string') sections = JSON.parse(sections)
  const now = new Date().toISOString()
  const rows = (sections as Section[]).map((s) => ({
    id: randomUUID(),
    __typename: 'ScheduleChange',
    relatedRequestId: requestId,
    program: s.program,
    branch: s.branch,
    section: s.section,
    day,
    startTime,
    endTime,
    courseId: purpose,
    ...(room ? { room } : {}),
    changeType: 'SCHEDULED',
    createdAt: now,
    updatedAt: now,
  }))
  await writeChanges(rows)
  await ddb.send(
    new UpdateCommand({
      TableName: SR,
      Key: { id: requestId },
      UpdateExpression: 'SET #s = :c, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':c': 'CONFIRMED', ':now': now },
    }),
  )
  return JSON.stringify({ confirmed: rows.length })
}
