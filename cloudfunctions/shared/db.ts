export const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
  powerRecords: 'power_records',
  notificationRecords: 'notification_records',
  jobLocks: 'job_locks',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]

export interface DatabaseAdapter {
  collection<T>(name: CollectionName): T
}

export function getDatabase(): DatabaseAdapter {
  // TODO: Initialize and return wx-server-sdk database instance in each cloud function.
  throw new Error('Database adapter is not initialized')
}
