import { defineFunction } from '@aws-amplify/backend';

export const importData = defineFunction({
  name: 'import-data',
  entry: './handler.ts',
  timeoutSeconds: 120,
  memoryMB: 1024,
  // Needs the data tables' names and grants; living in the data stack
  // avoids a data <-> function stack dependency cycle.
  resourceGroupName: 'data',
});
