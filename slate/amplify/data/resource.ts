import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

/**
 * Slate's data model (see CLAUDE.md §4).
 *
 * All models require a signed-in @iiita.ac.in user (enforced by the
 * Cognito domain gate in amplify/auth). "Anyone can view" in the product
 * brief means any signed-in user, not a fully public/anonymous visitor.
 */
const schema = a.schema({
  Role: a.enum(['FACULTY', 'STUDENT']),
  RequestStatus: a.enum(['PROPOSED', 'CONFIRMED']),
  ChangeType: a.enum(['SCHEDULED', 'CANCELLED']),

  User: a
    .model({
      email: a.string().required(),
      role: a.ref('Role').required(),
      // One-time identity link (CLAUDE.md §4a) — points at an existing
      // real section/faculty name already in TimetableSlot, never new
      // schedule data. { program, branch, section } for students.
      linkedSection: a.json(),
      // Real faculty display name as it appears in TimetableSlot.faculty.
      linkedFacultyName: a.string(),
    })
    .authorization((allow) => [allow.authenticated().to(['read']), allow.owner()]),

  // Read-only from the app's point of view: ingested from official AAA
  // timetable PDFs by the Textract/Bedrock batch job (see CLAUDE.md §3),
  // never edited by users.
  TimetableSlot: a
    .model({
      program: a.string().required(),
      branch: a.string().required(),
      section: a.string().required(),
      semester: a.integer().required(),
      day: a.string().required(),
      startTime: a.string().required(),
      endTime: a.string().required(),
      courseId: a.string().required(),
      room: a.string(),
      // Real faculty name from the course-legend table in the source
      // spreadsheet (added Day 2 for the teacher dashboard).
      faculty: a.string(),
    })
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  SlotRequest: a
    .model({
      requesterId: a.string().required(),
      status: a.ref('RequestStatus').required(),
      // { program, branch, section }[] — stored as JSON rather than a
      // ref'd array of a custom type, which hits a type-inference wall
      // in the current @aws-amplify/backend version and widens the
      // whole model's generated client types to `string[]`.
      sections: a.json().required(),
      // { earliestTime?, latestTime?, allowedDays?, minDurationMins? }
      constraints: a.json(),
    })
    // TODO (Day 3): the PROPOSED -> CONFIRMED transition (via 'update') is
    // the one action CLAUDE.md gates to role: FACULTY via Cedar. Plain
    // model authorization can't express that role check, so this is open
    // to any authenticated user for now -- same acknowledged gap as
    // ScheduleChange.create below. Moving both to a role-checked custom
    // mutation once Cedar is wired up.
    .authorization((allow) => [allow.authenticated().to(['read', 'create', 'update'])]),

  // Written only by the slot-finding Lambda; the app only ever reads these.
  ProposedSlot: a
    .model({
      requestId: a.id().required(),
      day: a.string().required(),
      startTime: a.string().required(),
      endTime: a.string().required(),
      room: a.string(),
      score: a.integer().required(),
      reason: a.string().required(),
      // { program, branch, section } — present only when no slot works
      blockingSection: a.json(),
    })
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Replaces the SES email (see CLAUDE.md §2/§3): confirming a slot writes
  // one of these, and the student/teacher dashboards for the affected
  // section render it as a highlight on their own timetable grid.
  ScheduleChange: a
    .model({
      relatedRequestId: a.id().required(),
      program: a.string().required(),
      branch: a.string().required(),
      section: a.string().required(),
      day: a.string().required(),
      startTime: a.string().required(),
      endTime: a.string().required(),
      courseId: a.string().required(),
      room: a.string(),
      changeType: a.ref('ChangeType').required(),
    })
    // TODO (Day 3): same gap as SlotRequest above — creating a
    // ScheduleChange is the actual "Confirm" action CLAUDE.md gates to
    // role: FACULTY via Cedar. Moving to a role-checked custom mutation
    // once that's built; open to any authenticated user for now.
    .authorization((allow) => [allow.authenticated().to(['read', 'create'])]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
