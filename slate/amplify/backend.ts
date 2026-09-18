import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { parseTimetable } from './functions/parse-timetable/resource';

defineBackend({
  auth,
  data,
  storage,
  parseTimetable,
});
