import { defineStorage } from '@aws-amplify/backend';
import { parseTimetable } from '../functions/parse-timetable/resource';

// Uploaded source timetables. TODO: same acknowledged gap as the
// TimetableSlot model -- writes should be ADMIN-only via Cedar.
export const storage = defineStorage({
  name: 'timetableUploads',
  access: (allow) => ({
    'timetable-uploads/*': [
      allow.authenticated.to(['read', 'write']),
      allow.resource(parseTimetable).to(['read']),
    ],
  }),
});
