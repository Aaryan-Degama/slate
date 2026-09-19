import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { parseTimetable } from './functions/parse-timetable/resource';
import { importData } from './functions/import-data/resource';
import { findSlots } from './functions/find-slots/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  parseTimetable,
  importData,
  findSlots,
});

// import-data writes the validated rows straight to DynamoDB.
const tables = backend.data.resources.tables;
const importFn = backend.importData.resources.lambda;
for (const [model, env] of [
  ['TimetableSlot', 'TIMETABLE_SLOT_TABLE'],
  ['StudentSection', 'STUDENT_SECTION_TABLE'],
] as const) {
  tables[model].grantReadWriteData(importFn);
  backend.importData.addEnvironment(env, tables[model].tableName);
}

// find-slots reads timetables and already-scheduled sessions.
const findFn = backend.findSlots.resources.lambda;
for (const [model, env] of [
  ['TimetableSlot', 'TIMETABLE_SLOT_TABLE'],
  ['ScheduleChange', 'SCHEDULE_CHANGE_TABLE'],
] as const) {
  tables[model].grantReadData(findFn);
  backend.findSlots.addEnvironment(env, tables[model].tableName);
}
