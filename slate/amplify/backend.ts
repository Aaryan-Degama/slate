import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { parseTimetable } from './functions/parse-timetable/resource';
import { importData } from './functions/import-data/resource';
import { findSlots } from './functions/find-slots/resource';
import { confirmSlot } from './functions/confirm-slot/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  parseTimetable,
  importData,
  findSlots,
  confirmSlot,
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

// find-slots reads timetables and already-scheduled sessions.
const findFn = backend.findSlots.resources.lambda;
for (const [model, env] of [
  ['TimetableSlot', 'TIMETABLE_SLOT_TABLE'],
  ['ScheduleChange', 'SCHEDULE_CHANGE_TABLE'],
] as const) {
  tables[model].grantReadData(findFn);
  backend.findSlots.addEnvironment(env, tables[model].tableName);
}

// confirm-slot reads the request (or class, and the caller's User row)
// and writes the confirmation or cancellation.
const confirmFn = backend.confirmSlot.resources.lambda;
tables.TimetableSlot.grantReadData(confirmFn);
tables.User.grantReadData(confirmFn);
backend.confirmSlot.addEnvironment('TIMETABLE_SLOT_TABLE', tables.TimetableSlot.tableName);
backend.confirmSlot.addEnvironment('USER_TABLE', tables.User.tableName);
tables.SlotRequest.grantReadWriteData(confirmFn);
tables.ScheduleChange.grantWriteData(confirmFn);
backend.confirmSlot.addEnvironment('SLOT_REQUEST_TABLE', tables.SlotRequest.tableName);
backend.confirmSlot.addEnvironment('SCHEDULE_CHANGE_TABLE', tables.ScheduleChange.tableName);
