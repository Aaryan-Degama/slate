import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { parseTimetable } from '../functions/parse-timetable/resource';
import { importData } from '../functions/import-data/resource';
import { findSlots } from '../functions/find-slots/resource';
import { sectionChanges } from '../functions/section-changes/resource';

/**
 * Slate's data model (see CLAUDE.md §4).
 *
 * All models require a signed-in @iiita.ac.in user (enforced by the
 * Cognito domain gate in amplify/auth). "Anyone can view" in the product
 * brief means any signed-in user, not a fully public/anonymous visitor.
 */
const schema = a.schema({
  Role: a.enum(['STUDENT', 'FACULTY', 'ADMIN']),
  // CANCELLED: a regular class called off on one date. EXTRA: a one-off
  // class. MOVED_FROM/MOVED_TO: the two halves of a move (same groupId).
  ChangeKind: a.enum(['CANCELLED', 'EXTRA', 'MOVED_FROM', 'MOVED_TO']),

  User: a
    .model({
      email: a.string().required(),
      role: a.ref('Role').required(),
      // One-time identity link (CLAUDE.md §4a) — points at an existing
      // real section/faculty name already in TimetableSlot, never new
      // schedule data. { program, branch, section } for students.
      linkedSection: a.json(),
      // When the student last looked at their "What changed" feed; changes
      // made after this are shown as new (kept here so it follows them
      // across devices).
      changesSeenAt: a.datetime(),
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

  // A dated change to a timetable, made by a CR (or an admin) through the
  // section-changes Lambda -- the app only reads these. One action (e.g.
  // "cancel IML on 22 Sep") writes one row per affected section, sharing a
  // groupId. changedBy/undoneBy make every change traceable to a person;
  // undo marks rows instead of deleting them, so the history stays complete.
  ScheduleChange: a
    .model({
      groupId: a.string().required(),
      kind: a.ref('ChangeKind').required(),
      date: a.string().required(), // YYYY-MM-DD (IST)
      program: a.string().required(),
      branch: a.string().required(),
      semester: a.integer().required(),
      section: a.string().required(),
      startTime: a.string().required(),
      endTime: a.string().required(),
      courseId: a.string().required(),
      sessionType: a.string(),
      room: a.string(),
      faculty: a.string(),
      // The regular class a cancellation / move refers to.
      relatedSlotId: a.id(),
      changedBy: a.string().required(), // email
      changedBySub: a.string(),
      changedBySection: a.string(),
      undoneBy: a.string(),
      undoneAt: a.datetime(),
    })
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // A section's class representative: the one student who may change that
  // section's timetable. Claimed by the student (first come) through the
  // section-changes Lambda; an admin revokes by deleting the row.
  ClassRep: a
    .model({
      sectionKey: a.string().required(), // "program|branch|semester|section"
      program: a.string().required(),
      branch: a.string().required(),
      semester: a.integer().required(),
      section: a.string().required(),
      sub: a.string().required(), // Cognito user id
      email: a.string().required(),
    })
    .authorization((allow) => [allow.authenticated().to(['read']), allow.group('ADMIN').to(['read', 'delete'])]),

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

  // Dated free slots for a course's sections and its professor, ranked
  // with reasons and a free room, or who blocks it (JSON string).
  findSlots: a
    .query()
    .arguments({
      groups: a.string().array().required(), // "program|branch|semester|section"
      dates: a.string().array().required(), // YYYY-MM-DD
      courseId: a.string(), // adds the course professor's timetable
      ignoreSlotId: a.string(), // a move: the class being moved doesn't block itself
      earliestTime: a.string(),
      latestTime: a.string(),
      minDurationMins: a.integer(),
    })
    .returns(a.json())
    .handler(a.handler.function(findSlots))
    .authorization((allow) => [allow.authenticated()]),

  // Timetable changes, all through the section-changes Lambda, where the
  // Cedar policy (functions/section-changes/policy.cedar) decides. Open to
  // every signed-in user on purpose -- the policy, not the API layer,
  // decides who may do what. Dates are YYYY-MM-DD.
  claimCr: a
    .mutation()
    .returns(a.json())
    .handler(a.handler.function(sectionChanges))
    .authorization((allow) => [allow.authenticated()]),
  cancelOccurrence: a
    .mutation()
    .arguments({ slotId: a.id().required(), date: a.string().required() })
    .returns(a.json())
    .handler(a.handler.function(sectionChanges))
    .authorization((allow) => [allow.authenticated()]),
  addExtra: a
    .mutation()
    .arguments({
      courseId: a.string().required(),
      date: a.string().required(),
      startTime: a.string().required(),
      endTime: a.string().required(),
      room: a.string(),
      // Subset of the course's sections; empty = all of them.
      sections: a.string().array(),
      // Admins only: which batch (a CR's batch is their own).
      program: a.string(),
      branch: a.string(),
      semester: a.integer(),
    })
    .returns(a.json())
    .handler(a.handler.function(sectionChanges))
    .authorization((allow) => [allow.authenticated()]),
  moveOccurrence: a
    .mutation()
    .arguments({
      slotId: a.id().required(),
      fromDate: a.string().required(),
      date: a.string().required(),
      startTime: a.string().required(),
      endTime: a.string().required(),
      room: a.string(),
    })
    .returns(a.json())
    .handler(a.handler.function(sectionChanges))
    .authorization((allow) => [allow.authenticated()]),
  undoChange: a
    .mutation()
    .arguments({ groupId: a.string().required() })
    .returns(a.json())
    .handler(a.handler.function(sectionChanges))
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
      // Import only these sections (a sheet mixing branches, e.g. 1st sem).
      onlySections: a.string().array(),
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
