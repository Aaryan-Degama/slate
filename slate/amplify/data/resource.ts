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

  // A single { program, branch, section } combination — reused for the
  // sections a request targets and, when no slot works, the section
  // identified as the blocker.
  SectionRef: a.customType({
    program: a.string().required(),
    branch: a.string().required(),
    section: a.string().required(),
  }),

  Constraints: a.customType({
    earliestTime: a.string(),
    latestTime: a.string(),
    allowedDays: a.string().array(),
    minDurationMins: a.integer(),
  }),

  User: a
    .model({
      email: a.string().required(),
      role: a.ref('Role').required(),
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
    })
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  SlotRequest: a
    .model({
      requesterId: a.string().required(),
      status: a.ref('RequestStatus').required(),
      sections: a.ref('SectionRef').required().array(),
      constraints: a.ref('Constraints'),
    })
    // TODO (Day 3): the PROPOSED -> CONFIRMED transition is the one
    // action CLAUDE.md gates to role: FACULTY via Cedar. Plain model
    // 'update' access can't express that role check, so this will move
    // to a custom Confirm & Notify mutation/Lambda once that's built.
    // Leaving 'update' open here for now would let anyone confirm.
    .authorization((allow) => [allow.authenticated().to(['read', 'create'])]),

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
      blockingSection: a.ref('SectionRef'),
    })
    .authorization((allow) => [allow.authenticated().to(['read'])]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
