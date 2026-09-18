import { defineStorage } from '@aws-amplify/backend';
import { parseTimetable } from '../functions/parse-timetable/resource';
import { importData } from '../functions/import-data/resource';

// Uploaded source files (timetables, student lists). Only the ADMIN
// group can upload; the two Lambdas read them.
export const storage = defineStorage({
  name: 'timetableUploads',
  access: (allow) => ({
    'timetable-uploads/*': [
      allow.groups(['ADMIN']).to(['read', 'write']),
      allow.resource(parseTimetable).to(['read']),
      allow.resource(importData).to(['read']),
    ],
  }),
});
