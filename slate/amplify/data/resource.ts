import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { parseTimetable } from '../functions/parse-timetable/resource';
import { importData } from '../functions/import-data/resource';
import { findSlots } from '../functions/find-slots/resource';

/**
 * Slate's data model (see CLAUDE.md §4).
 *
 * All models require a signed-in @iiita.ac.in user (enforced by the
 * Cognito domain gate in amplify/auth). "Anyone can view" in the product
 * brief means any signed-in user, not a fully public/anonymous visitor.
 */
const schema = a.schema({
  Role: a.enum(['STUDENT', 'FACULTY', 'ADMIN']),
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

  // Ingested from official AAA timetable PDFs/sheets (see CLAUDE.md §3),
  // never edited by students/faculty. Write access exists for the Admin
  // correction UI, which fixes real mistakes an extraction pass made
  // (see NOTES.md) -- this is curation of already-ingested data by the
  // admin role, not open editing.
  // Writes are limited to the Cognito ADMIN group (the editor and the
  // import Lambda); everyone signed in can read.
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
      // L (lecture) | P (practical) | T (tutorial), from the "(L)"/"(P)"
      // tag in the source cell text -- captured during extraction but
      // originally discarded; backfilled from the same real source.
      sessionType: a.string(),
    })
    .authorization((allow) => [allow.authenticated().to(['read']), allow.group('ADMIN')]),

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
    // Creating/confirming a request is faculty-only (Cognito FACULTY group;
    // admins too). Anyone signed in can read.
    .authorization((allow) => [
      allow.authenticated().to(['read']),
      allow.groups(['FACULTY', 'ADMIN']).to(['read', 'create', 'update']),
    ]),

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
    // Writing one is the Confirm action: FACULTY group (and admins) only.
    .authorization((allow) => [
      allow.authenticated().to(['read']),
      allow.groups(['FACULTY', 'ADMIN']).to(['read', 'create']),
    ]),

  // The roll-number -> section mapping (CLAUDE.md §4a), as real data
  // instead of hardcoded app code. An admin provides ranges per
  // batch/semester (via a CSV upload in the app -- see AdminDashboard's
  // sub-section gap prompt); a student's section is resolved by finding
  // which range their roll number falls in.
  RollRange: a
    .model({
      admissionYear: a.string().required(), // matches the year embedded in the email
      program: a.string().required(),
      branch: a.string().required(),
      semester: a.integer().required(),
      minRoll: a.integer().required(),
      maxRoll: a.integer().required(),
      section: a.string().required(),
    })
    .authorization((allow) => [allow.authenticated().to(['read']), allow.group('ADMIN')]),

  // One row per student: which section (and B1/B2-style sub-section, if
  // the batch splits) they belong to, from an admin-uploaded student
  // list. Takes precedence over RollRange, which only fits clean
  // contiguous ranges. Courses and faculty are NOT stored here -- they
  // follow from the section's TimetableSlot rows.
  // Written only by the import-data Lambda (ADMIN group).
  StudentSection: a
    .model({
      admissionYear: a.string().required(),
      rollNumber: a.integer().required(),
      program: a.string().required(),
      branch: a.string().required(),
      semester: a.integer().required(),
      section: a.string().required(),
      subSection: a.string(),
    })
    .authorization((allow) => [allow.authenticated().to(['read']), allow.group('ADMIN')]),

  // Common free slots across sections, ranked with reasons, a suggested
  // room, and the blocking section when none exist (JSON string).
  findSlots: a
    .query()
    .arguments({
      groups: a.string().array().required(), // "program|branch|semester|section"
      earliestTime: a.string(),
      latestTime: a.string(),
      allowedDays: a.string().array(),
      minDurationMins: a.integer(),
    })
    .returns(a.json())
    .handler(a.handler.function(findSlots))
    .authorization((allow) => [allow.authenticated()]),

  // Admin upload: parses a timetable file already uploaded to S3 and
  // returns proposed rows + validation issues per sheet (JSON string).
  // Read-only; the admin applies the result from the app.
  parseTimetable: a
    .query()
    .arguments({ key: a.string().required() })
    .returns(a.json())
    .handler(a.handler.function(parseTimetable))
    .authorization((allow) => [allow.group('ADMIN')]),

  // Admin upload, second step: re-reads the file from S3, validates it
  // with the admin's confirmed column mapping, diffs against DynamoDB and
  // (unless dryRun) writes the changes. Returns a summary (JSON string).
  importData: a
    .mutation()
    .arguments({
      key: a.string().required(),
      sheet: a.string().required(),
      kind: a.string().required(), // 'timetable' | 'students'
      program: a.string().required(),
      branch: a.string().required(),
      semester: a.integer().required(),
      rollCol: a.integer(),
      emailCol: a.integer(),
      sectionCol: a.integer(),
      subSectionCol: a.integer(),
      admissionYear: a.string(),
      // The review screen's "same for every row" fields.
      sectionOverride: a.string(),
      subSectionOverride: a.string(),
      // Timetables whose classes name no section (single-section batch).
      defaultSection: a.string(),
      removeMissing: a.boolean(),
      dryRun: a.boolean().required(),
    })
    .returns(a.json())
    .handler(a.handler.function(importData))
    .authorization((allow) => [allow.group('ADMIN')]),

  // Per-student course registration -- currently only meaningful for
  // electives, since core courses are already implied by section
  // membership in TimetableSlot. Intentionally left EMPTY for now: we
  // don't have real per-student registration data yet. Schema exists so
  // an admin-run ingestion pipeline (planned: OCR over registration
  // sheets) has somewhere real to write once that data exists -- not
  // fabricated here.
  CourseRegistration: a
    .model({
      rollNumber: a.string().required(),
      admissionYear: a.string().required(),
      program: a.string().required(),
      branch: a.string().required(),
      semester: a.integer().required(),
      courseId: a.string().required(),
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
