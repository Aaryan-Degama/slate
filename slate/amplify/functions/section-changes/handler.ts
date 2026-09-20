// Every change to a timetable after ingestion goes through here, and every
// one is decided by the Cedar policy in policy.cedar (CLAUDE.md §2, §4):
// - claimCr:          become your section's class representative (CR)
// - cancelOccurrence: cancel a regular class on one date
// - addExtra:         add a one-off class of a course on one date
// - moveOccurrence:   cancel an occurrence and add it elsewhere, linked
// - undoChange:       undo a change (whole, or for your own section)
// and two read-only queries that need the admin-only student list:
// - mySection:        the caller's section, from their verified email
// - batchRoster:      every section of the caller's batch: CR + roll numbers
// A change applies to every section of the batch taking the course: one
// ScheduleChange row per section, sharing a groupId. Rows record who made
// them; undo marks them (undoneBy/undoneAt) instead of deleting them.
import { randomUUID } from 'node:crypto'
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { initSync, isAuthorized, type CedarValueJson } from '@cedar-policy/cedar-wasm/web'
import { CEDAR_WASM_BASE64, POLICY } from './embedded.gen'
import { attended, homeOf } from '../shared/attendance'

initSync({ module: Buffer.from(CEDAR_WASM_BASE64, 'base64') })

type Identity = { sub: string; username?: string; groups?: string[] | null; claims?: { email?: string } }
// Amplify's function resolver puts fieldName at the top level; a plain
// AppSync Lambda resolver puts it under info. Accept both.
type Event = { fieldName?: string; info?: { fieldName: string }; arguments: Record<string, unknown>; identity: Identity }
type Row = Record<string, unknown>
type Batch = { program: string; branch: string; semester: number }
type Section = Batch & { section: string }
type Entity = { uid: { type: string; id: string }; attrs: Record<string, CedarValueJson>; parents: [] }

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const env = (k: string) => process.env[k]!
const [SC, TT, CR, SS, RR, EN] = ['SCHEDULE_CHANGE_TABLE', 'TIMETABLE_SLOT_TABLE', 'CLASS_REP_TABLE', 'STUDENT_SECTION_TABLE', 'ROLL_RANGE_TABLE', 'ENROLLMENT_TABLE'].map(env)
const [OF, ME, RG] = ['OFFERING_TABLE', 'CLASS_MEETING_TABLE', 'REGISTRATION_TABLE'].map(env)

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

const batchKey = (b: Row | Batch) => `${b.program}|${b.branch}|${b.semester}`
const inBatch = (r: Row, b: Batch) => r.program === b.program && r.branch === b.branch && Number(r.semester) === b.semester
/** CRs are per main section: a B1/B2 class belongs to B's CR. */
const keyOf = (s: Row | Section) => `${batchKey(s)}|${String(s.section)[0]}`
const user = (sub: string) => ({ type: 'Slate::User', id: sub })

/** Where the student list (or, failing that, a roll range) puts this email: their home section. */
async function resolve(email: string) {
  const [students, ranges] = await Promise.all([scanAll(SS), scanAll(RR)])
  return homeOf(email, students, ranges)
}

/** The caller's section for authorization: main section only (B1 -> B). */
async function sectionOf(email: string): Promise<Section | null> {
  const r = await resolve(email)
  return r && { program: r.program, branch: r.branch, semester: r.semester, section: r.section }
}

// The app authenticates with Cognito *access* tokens, which carry no email
// claim, so look the verified email up in the user pool by the caller's
// (token-verified) username. Never from the User table: users can edit their
// own row there.
const cognito = new CognitoIdentityProviderClient({})
const emails = new Map<string, string>()
async function emailOf(identity: Identity): Promise<string> {
  if (identity.claims?.email) return identity.claims.email
  const username = identity.username ?? identity.sub
  if (!emails.has(username)) {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID!, Username: username }))
    const attr = (n: string) => user.UserAttributes?.find((x) => x.Name === n)?.Value
    emails.set(username, attr('email_verified') === 'true' ? (attr('email') ?? '') : '')
  }
  return emails.get(username)!
}

const roleOf = (groups: string[]) => (groups.includes('ADMIN') ? 'ADMIN' : 'STUDENT')

// ---------------------------------------------------------------- dates
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const weekdayOf = (date: string) => DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()]
/** Today in IST, as YYYY-MM-DD. */
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
const addDays = (date: string, n: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10)
/** Monday of `date`'s week (Sat/Sun roll forward, as in src/lib/grid.ts mondayOf). */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDays(date, d === 0 ? 1 : d === 6 ? 2 : 1 - d)
}
/** Changes are only for this week and next: from today to next week's Friday. */
function checkDate(date: unknown): string {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new Error('Pick a date.')
  if (date < todayIst()) throw new Error('That date has already passed.')
  if (date > addDays(mondayOf(todayIst()), 11)) throw new Error('Changes can only be made for this week and next.')
  return date
}
/** TTL (epoch seconds): the Monday after the change's week, when it stops being shown. */
const expiresAt = (date: string) => Math.floor(new Date(`${addDays(mondayOf(date), 7)}T00:00:00+05:30`).getTime() / 1000)

// ---------------------------------------------------------------- Cedar
type Ctx = { identity: Identity; email: string; mine: Section | null; reps: Row[]; principal: Entity }

async function context(identity: Identity): Promise<Ctx> {
  const email = await emailOf(identity)
  const [mine, reps] = await Promise.all([sectionOf(email), scanAll(CR)])
  const principal: Entity = {
    uid: user(identity.sub),
    attrs: { role: roleOf(identity.groups ?? []), section: mine ? keyOf(mine) : '' },
    parents: [],
  }
  return { identity, email, mine, reps, principal }
}

/** Ask Cedar; throws with `denied` unless the policy allows it. Every decision is logged. */
function authorize(ctx: Ctx, action: string, resource: Entity, denied: string) {
  const answer = isAuthorized({
    principal: ctx.principal.uid,
    action: { type: 'Slate::Action', id: action },
    resource: resource.uid,
    context: {},
    policies: { staticPolicies: POLICY },
    entities: [ctx.principal, resource],
  })
  if (answer.type === 'failure') throw new Error(`Cedar error: ${answer.errors.map((e) => e.message).join('; ')}`)
  const decision = answer.response.decision
  console.log(JSON.stringify({ cedar: decision, action, email: ctx.email, principal: ctx.principal.attrs, resource: resource.uid.id }))
  if (decision !== 'allow') throw new Error(denied)
}

const sectionEntity = (ctx: Ctx, key: string): Entity => {
  const rep = ctx.reps.find((r) => r.sectionKey === key)
  const attrs: Record<string, CedarValueJson> = { key, hasCr: Boolean(rep) }
  if (rep) attrs.cr = { __entity: user(String(rep.sub)) }
  return { uid: { type: 'Slate::Section', id: key }, attrs, parents: [] }
}

/** An offering, with the CRs of the sections it is timetabled for. */
const offeringEntity = (ctx: Ctx, offering: Row): Entity => {
  const sections = ((offering.sections as string[]) ?? []).map((sec) => `${batchKey(offering)}|${String(sec)[0]}`)
  const crs = ctx.reps.filter((r) => sections.includes(String(r.sectionKey))).map((r) => ({ __entity: user(String(r.sub)) }))
  return { uid: { type: 'Slate::Offering', id: String(offering.offeringKey) }, attrs: { crs }, parents: [] }
}

/** A course's class(es) in a batch, with the CRs of every section in them. */
const courseEntity = (ctx: Ctx, batch: Batch, courseId: string, rows: Row[]): Entity => {
  const keys = new Set(rows.map(keyOf))
  const crs = ctx.reps.filter((r) => keys.has(String(r.sectionKey))).map((r) => ({ __entity: user(String(r.sub)) }))
  return { uid: { type: 'Slate::Course', id: `${batchKey(batch)}|${courseId}` }, attrs: { crs }, parents: [] }
}

// ---------------------------------------------------------------- helpers
/** The sections a change reaches: B covers B1/B2, so drop sub-sections whose main section is present. */
function reach(sections: string[]): string[] {
  const set = new Set(sections)
  return [...set].filter((s) => !(s.length === 2 && set.has(s[0]))).sort()
}

async function writeRows(rows: Row[]) {
  for (let i = 0; i < rows.length; i += 25)
    await ddb.send(new BatchWriteCommand({ RequestItems: { [SC]: rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }))
}

function newRow(ctx: Ctx, groupId: string, fields: Row): Row {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    __typename: 'ScheduleChange',
    groupId,
    ...fields,
    expiresAt: expiresAt(String(fields.date)),
    changedBy: ctx.email,
    changedBySub: ctx.identity.sub,
    changedBySection: ctx.mine ? `${ctx.mine.section}` : null,
    createdAt: now,
    updatedAt: now,
  }
}

const live = (r: Row) => !r.undoneAt

/** What a change records about the class it changes (display + matching). */
const changeFields = (offering: Row, meeting: Row | null, kind: string, date: string): Row => ({
  kind,
  date,
  offeringKey: offering.offeringKey,
  ...(meeting ? { meetingId: meeting.id, startTime: meeting.startTime, endTime: meeting.endTime, ...(meeting.room ? { room: meeting.room } : {}), ...(meeting.sessionType ? { sessionType: meeting.sessionType } : {}) } : {}),
  courseId: offering.courseCode,
  ...(offering.faculty ? { faculty: offering.faculty } : {}),
  program: offering.program,
  branch: offering.branch,
  semester: offering.semester,
  section: ((offering.sections as string[]) ?? []).join(', '),
})

/** The regular class `slotId` on `date`, across every section it's held for together. */
async function occurrence(slotId: string, date: string, slots: Row[]) {
  const slot = slots.find((r) => r.id === slotId)
  if (!slot) throw new Error('No such class.')
  if (weekdayOf(date) !== slot.day) throw new Error(`${slot.courseId} isn't held on ${weekdayOf(date)}.`)
  const batch: Batch = { program: String(slot.program), branch: String(slot.branch), semester: Number(slot.semester) }
  const together = slots.filter(
    (r) =>
      inBatch(r, batch) &&
      r.courseId === slot.courseId &&
      r.day === slot.day &&
      r.startTime === slot.startTime &&
      r.endTime === slot.endTime &&
      (r.sessionType ?? '') === (slot.sessionType ?? ''),
  )
  return { slot, batch, together }
}

async function assertNotCancelled(together: Row[], date: string) {
  const ids = new Set(together.map((r) => r.id))
  const existing = (await scanAll(SC)).find(
    (c) => live(c) && c.date === date && ids.has(c.relatedSlotId) && (c.kind === 'CANCELLED' || c.kind === 'MOVED_FROM'),
  )
  if (existing) throw new Error('That class is already cancelled or moved on that date.')
}

const cancelRows = (ctx: Ctx, groupId: string, kind: string, date: string, together: Row[]) =>
  together.map((r) =>
    newRow(ctx, groupId, {
      kind,
      date,
      program: r.program,
      branch: r.branch,
      semester: r.semester,
      section: r.section,
      startTime: r.startTime,
      endTime: r.endTime,
      courseId: r.courseId,
      sessionType: r.sessionType ?? null,
      ...(r.room ? { room: r.room } : {}),
      ...(r.faculty ? { faculty: r.faculty } : {}),
      relatedSlotId: r.id,
    }),
  )

function extraRows(ctx: Ctx, groupId: string, kind: string, batch: Batch, courseRows: Row[], sections: string[], a: Row) {
  const faculty = courseRows.find((r) => r.faculty)?.faculty
  return sections.map((section) =>
    newRow(ctx, groupId, {
      kind,
      date: a.date,
      ...batch,
      section,
      startTime: a.startTime,
      endTime: a.endTime,
      courseId: courseRows[0].courseId,
      ...(a.room ? { room: a.room } : {}),
      ...(faculty ? { faculty } : {}),
    }),
  )
}

/** Sections for an extra class: every section of the batch taking the course, or the chosen subset of them. */
function extraSections(courseRows: Row[], chosen: unknown): string[] {
  const all = reach(courseRows.map((r) => String(r.section)))
  const pick = Array.isArray(chosen) ? (chosen as string[]).filter(Boolean) : []
  if (!pick.length) return all
  const ok = pick.filter((s) => all.includes(s))
  if (ok.length !== pick.length) throw new Error(`Only sections your professor teaches for this course can be included (${all.join(", ")}).`)
  return ok
}

function checkTimes(a: Row) {
  const t = /^\d{2}:\d{2}$/
  if (!t.test(String(a.startTime)) || !t.test(String(a.endTime)) || String(a.startTime) >= String(a.endTime))
    throw new Error('Pick a valid time.')
}

// ---------------------------------------------------------------- handler
export const handler = async (event: Event) => {
  const field = event.fieldName ?? event.info?.fieldName
  const a = event.arguments
  const email = await emailOf(event.identity)

  if (field === 'myTimetable') {
    // A student attends the offerings they're registered in
    // (docs/DATA-MODEL.md) -- their section only decides lab-split groups.
    const home = await resolve(email)
    if (!home) return JSON.stringify(null)
    const [regs, offerings, meetings] = await Promise.all([scanAll(RG), scanAll(OF), scanAll(ME)])
    const mine = new Set(regs.filter((r) => r.rollId === home.rollId).map((r) => String(r.offeringKey)))
    const myOfferings = offerings.filter((o) => mine.has(String(o.offeringKey)))
    const sub = home.subSection
    const myMeetings = meetings
      .filter((m) => mine.has(String(m.offeringKey)))
      // A lab split (group "B1"/"B2"): only that half attends. A student
      // whose own split isn't known yet sees both halves of their section's
      // labs, and never another section's.
      .filter((m) => !m.group || m.group === sub || (!sub && String(m.group)[0] === home.section))
      .map((m) => {
        const o = myOfferings.find((x) => x.offeringKey === m.offeringKey)
        return {
          id: m.id,
          offeringKey: m.offeringKey,
          courseId: o?.courseCode ?? '',
          courseName: o?.courseName ?? null,
          kind: o?.kind ?? null,
          faculty: o?.faculty ?? null,
          section: m.group ?? (Array.isArray(o?.sections) ? (o!.sections as string[]).join(', ') : ''),
          day: m.day,
          startTime: m.startTime,
          endTime: m.endTime,
          room: m.room ?? null,
          sessionType: m.sessionType ?? null,
        }
      })
    return JSON.stringify({
      ...home,
      offerings: myOfferings.map((o) => ({
        offeringKey: o.offeringKey,
        courseCode: o.courseCode,
        courseName: o.courseName ?? null,
        kind: o.kind ?? null,
        faculty: o.faculty ?? null,
        sections: o.sections ?? [],
      })),
      meetings: myMeetings,
    })
  }

  if (field === 'mySection') {
    // Home section (for the CR and the roster) plus exactly which classes
    // this student attends (enrollment exceptions applied).
    const home = await resolve(email)
    if (!home) return JSON.stringify(null)
    const [slots, enrollments] = await Promise.all([scanAll(TT), scanAll(EN)])
    return JSON.stringify({ ...home, attends: attended(home, slots, enrollments) })
  }

  if (field === 'batchRoster') {
    // Only the caller's own batch: roll numbers are shown to classmates, never across batches.
    const me = await resolve(email)
    if (!me) return JSON.stringify(null)
    const [students, ranges, reps] = await Promise.all([scanAll(SS), scanAll(RR), scanAll(CR)])
    const batch = { program: me.program, branch: me.branch, semester: me.semester }
    const mine = students.filter((r) => inBatch(r, batch))
    const letters = new Set([
      ...mine.map((r) => String(r.section)[0]),
      ...ranges.filter((r) => inBatch(r, batch)).map((r) => String(r.section)[0]),
    ])
    const sections = [...letters].sort().map((section) => {
      const rep = reps.find((r) => r.sectionKey === `${batchKey(batch)}|${section}`)
      return {
        section,
        cr: rep ? { email: rep.email, since: rep.createdAt } : null,
        students: mine
          .filter((r) => String(r.section)[0] === section)
          .map((r) => {
            const prefix = r.rollPrefix ? String(r.rollPrefix) : `I${String(r.branch).toUpperCase()}`
            return {
              id: `${prefix}${r.admissionYear}${String(r.rollNumber).padStart(3, '0')}`,
              name: r.name ?? null,
              subSection: r.subSection ?? (String(r.section).length === 2 ? r.section : null),
            }
          })
          .sort((x, y) => x.id.localeCompare(y.id)),
        // No student list uploaded for this section: say which rolls it covers instead.
        ranges: ranges
          .filter((r) => inBatch(r, batch) && String(r.section)[0] === section)
          .map((r) => ({ section: r.section, admissionYear: r.admissionYear, minRoll: r.minRoll, maxRoll: r.maxRoll })),
      }
    })
    return JSON.stringify({ ...batch, me: `${me.section}${me.subSection ? ` (${me.subSection})` : ''}`, meRollId: me.rollId, sections })
  }

  const ctx = await context(event.identity)

  switch (field) {
    case 'claimCr': {
      if (!ctx.mine) throw new Error("Your section couldn't be found from your roll number, so you can't claim CR yet.")
      const key = keyOf(ctx.mine)
      authorize(ctx, 'ClaimCr', sectionEntity(ctx, key), 'Your section already has a CR.')
      const now = new Date().toISOString()
      await ddb.send(
        new PutCommand({
          TableName: CR,
          Item: { id: randomUUID(), __typename: 'ClassRep', sectionKey: key, ...ctx.mine, sub: ctx.identity.sub, email: ctx.email, createdAt: now, updatedAt: now },
        }),
      )
      return JSON.stringify({ claimed: key })
    }

    case 'cancelOccurrence': {
      const date = checkDate(a.date)
      const [meetings, offerings] = await Promise.all([scanAll(ME), scanAll(OF)])
      const meeting = meetings.find((m) => m.id === a.meetingId)
      if (!meeting) throw new Error('No such class.')
      if (weekdayOf(date) !== meeting.day) throw new Error(`That class isn't held on ${weekdayOf(date)}.`)
      const offering = offerings.find((o) => o.offeringKey === meeting.offeringKey)
      if (!offering) throw new Error('That class has no offering.')
      authorize(ctx, 'Cancel', offeringEntity(ctx, offering), "Only a CR of this class's section can cancel it.")
      const clash = (await scanAll(SC)).find(
        (c) => live(c) && c.date === date && c.meetingId === meeting.id && (c.kind === 'CANCELLED' || c.kind === 'MOVED_FROM'),
      )
      if (clash) throw new Error('That class is already cancelled or moved on that date.')
      await writeRows([newRow(ctx, randomUUID(), changeFields(offering, meeting, 'CANCELLED', date))])
      return JSON.stringify({ cancelled: offering.courseCode })
    }

    case 'addExtra': {
      const date = checkDate(a.date)
      checkTimes(a)
      if (!['MON', 'TUE', 'WED', 'THU', 'FRI'].includes(weekdayOf(date))) throw new Error('Pick a weekday.')
      const offering = (await scanAll(OF)).find((o) => o.offeringKey === a.offeringKey)
      if (!offering) throw new Error('No such class.')
      authorize(ctx, 'AddExtra', offeringEntity(ctx, offering), "Only a CR of this class's section can add a class for it.")
      await writeRows([
        newRow(ctx, randomUUID(), { ...changeFields(offering, null, 'EXTRA', date), startTime: a.startTime, endTime: a.endTime, ...(a.room ? { room: a.room } : {}) }),
      ])
      return JSON.stringify({ added: offering.courseCode })
    }

    case 'moveOccurrence': {
      const fromDate = checkDate(a.fromDate)
      const date = checkDate(a.date)
      checkTimes(a)
      const [meetings, offerings] = await Promise.all([scanAll(ME), scanAll(OF)])
      const meeting = meetings.find((m) => m.id === a.meetingId)
      if (!meeting) throw new Error('No such class.')
      if (weekdayOf(fromDate) !== meeting.day) throw new Error(`That class isn't held on ${weekdayOf(fromDate)}.`)
      const offering = offerings.find((o) => o.offeringKey === meeting.offeringKey)
      if (!offering) throw new Error('That class has no offering.')
      authorize(ctx, 'Move', offeringEntity(ctx, offering), "Only a CR of this class's section can move it.")
      const groupId = randomUUID()
      await writeRows([
        newRow(ctx, groupId, changeFields(offering, meeting, 'MOVED_FROM', fromDate)),
        newRow(ctx, groupId, { ...changeFields(offering, meeting, 'MOVED_TO', date), startTime: a.startTime, endTime: a.endTime, ...(a.room ? { room: a.room } : { room: meeting.room }) }),
      ])
      return JSON.stringify({ moved: offering.courseCode })
    }

    case 'undoChange': {
      const groupId = String(a.groupId)
      const rows = (await scanAll(SC)).filter((r) => r.groupId === groupId && live(r))
      if (!rows.length) throw new Error('Nothing to undo.')
      const maker: Entity = { uid: { type: 'Slate::Change', id: groupId }, attrs: { maker: { __entity: user(String(rows[0].changedBySub ?? '')) } }, parents: [] }
      let targets = rows
      try {
        authorize(ctx, 'UndoGroup', maker, 'denied')
      } catch {
        // Not the maker: a CR may still take the change off their own section.
        if (!ctx.mine) throw new Error('Only whoever made this change, or an affected section’s CR, can undo it.')
        const key = keyOf(ctx.mine)
        targets = rows.filter((r) => keyOf(r) === key)
        if (!targets.length) throw new Error('This change doesn’t affect your section.')
        authorize(ctx, 'UndoSection', sectionEntity(ctx, key), 'Only whoever made this change, or an affected section’s CR, can undo it.')
      }
      const now = new Date().toISOString()
      for (const r of targets)
        await ddb.send(
          new UpdateCommand({
            TableName: SC,
            Key: { id: r.id },
            UpdateExpression: 'SET undoneBy = :by, undoneAt = :now, updatedAt = :now',
            ExpressionAttributeValues: { ':by': ctx.email, ':now': now },
          }),
        )
      return JSON.stringify({ undone: targets.map((r) => r.section) })
    }
  }
  throw new Error(`Unknown field ${field}`)
}
