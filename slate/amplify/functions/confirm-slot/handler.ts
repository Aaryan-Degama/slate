// Confirm (CLAUDE.md §2 screen 3): the only way a slot gets scheduled.
// Asks Cedar whether the caller may confirm this request, then writes one
// ScheduleChange per affected section and marks the request CONFIRMED.
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { initSync, isAuthorized } from '@cedar-policy/cedar-wasm/web'
import { CEDAR_WASM_BASE64, POLICY } from './embedded.gen'

initSync({ module: Buffer.from(CEDAR_WASM_BASE64, 'base64') })

type Args = { requestId: string; day: string; startTime: string; endTime: string; room?: string | null; purpose: string }
type Event = { arguments: Args; identity: { sub: string; groups?: string[] | null } }
type Section = { program: string; branch: string; section: string }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const SR = process.env.SLOT_REQUEST_TABLE!
const SC = process.env.SCHEDULE_CHANGE_TABLE!

// Cognito groups are the source of truth for roles (users can edit their
// own User row, not their groups).
const roleOf = (groups: string[]) =>
  groups.includes('ADMIN') ? 'ADMIN' : groups.includes('FACULTY') ? 'FACULTY' : 'STUDENT'

export const handler = async (event: Event) => {
  const { requestId, day, startTime, endTime, room, purpose } = event.arguments
  const { sub, groups } = event.identity
  const role = roleOf(groups ?? [])

  const request = (await ddb.send(new GetCommand({ TableName: SR, Key: { id: requestId } }))).Item
  if (!request) throw new Error('No such request.')

  const user = { type: 'Slate::User', id: sub }
  const answer = isAuthorized({
    principal: user,
    action: { type: 'Slate::Action', id: 'Confirm' },
    resource: { type: 'Slate::SlotRequest', id: requestId },
    context: {},
    policies: { staticPolicies: POLICY },
    entities: [
      { uid: user, attrs: { role }, parents: [] },
      {
        uid: { type: 'Slate::SlotRequest', id: requestId },
        attrs: { requester: { __entity: { type: 'Slate::User', id: String(request.requesterId) } } },
        parents: [],
      },
    ],
  })
  if (answer.type === 'failure') throw new Error(`Cedar error: ${answer.errors.map((e) => e.message).join('; ')}`)
  console.log(JSON.stringify({ cedar: answer.response.decision, principal: sub, role, requestId }))
  if (answer.response.decision !== 'allow') throw new Error('Not authorized: only the faculty member who raised this request can confirm it.')
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
  for (let i = 0; i < rows.length; i += 25)
    await ddb.send(
      new BatchWriteCommand({ RequestItems: { [SC]: rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }),
    )
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
