import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { parseTimetable } from './functions/parse-timetable/resource';
import { importData } from './functions/import-data/resource';
import { findSlots } from './functions/find-slots/resource';
import { sectionChanges } from './functions/section-changes/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  parseTimetable,
  importData,
  findSlots,
  sectionChanges,
});

// import-data writes the validated rows straight to DynamoDB.
const tables = backend.data.resources.tables;
const importFn = backend.importData.resources.lambda;
for (const [model, env] of [
  ['TimetableSlot', 'TIMETABLE_SLOT_TABLE'],
  ['StudentSection', 'STUDENT_SECTION_TABLE'],
  ['RollRange', 'ROLL_RANGE_TABLE'],
] as const) {
  tables[model].grantReadWriteData(importFn);
  backend.importData.addEnvironment(env, tables[model].tableName);
}

// find-slots reads timetables, changes, and who attends what (students,
// roll ranges, enrollments) to find every attendee of a class.
const findFn = backend.findSlots.resources.lambda;
for (const [model, env] of [
  ['TimetableSlot', 'TIMETABLE_SLOT_TABLE'],
  ['ScheduleChange', 'SCHEDULE_CHANGE_TABLE'],
  ['StudentSection', 'STUDENT_SECTION_TABLE'],
  ['RollRange', 'ROLL_RANGE_TABLE'],
  ['Enrollment', 'ENROLLMENT_TABLE'],
] as const) {
  tables[model].grantReadData(findFn);
  backend.findSlots.addEnvironment(env, tables[model].tableName);
}

// section-changes resolves the caller's section, checks the CR table and
// writes changes / CR claims.
const changesFn = backend.sectionChanges.resources.lambda;
for (const [model, env, write] of [
  ['ScheduleChange', 'SCHEDULE_CHANGE_TABLE', true],
  ['ClassRep', 'CLASS_REP_TABLE', true],
  ['TimetableSlot', 'TIMETABLE_SLOT_TABLE', false],
  ['StudentSection', 'STUDENT_SECTION_TABLE', false],
  ['RollRange', 'ROLL_RANGE_TABLE', false],
  ['Enrollment', 'ENROLLMENT_TABLE', false],
] as const) {
  if (write) tables[model].grantReadWriteData(changesFn);
  else tables[model].grantReadData(changesFn);
  backend.sectionChanges.addEnvironment(env, tables[model].tableName);
}
// ...and reads the caller's verified email from Cognito (access tokens don't carry it).
backend.sectionChanges.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId);
backend.auth.resources.userPool.grant(changesFn, 'cognito-idp:AdminGetUser');

// Changes only matter for this week and next (CLAUDE.md §2): each row
// carries expiresAt (epoch seconds, the Monday after its week) and
// DynamoDB's time-to-live deletes it after that, at no cost.
backend.data.resources.cfnResources.amplifyDynamoDbTables['ScheduleChange'].timeToLiveAttribute = {
  attributeName: 'expiresAt',
  enabled: true,
};
