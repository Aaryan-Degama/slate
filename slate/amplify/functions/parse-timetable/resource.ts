import { defineFunction } from '@aws-amplify/backend';

export const parseTimetable = defineFunction({
  name: 'parse-timetable',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 1024,
});
