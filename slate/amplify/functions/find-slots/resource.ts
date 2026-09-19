import { defineFunction } from '@aws-amplify/backend';

export const findSlots = defineFunction({
  name: 'find-slots',
  entry: './handler.ts',
  timeoutSeconds: 30,
  // Reads the data tables; living in the data stack avoids a dependency cycle.
  resourceGroupName: 'data',
});
