export const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
  powerRecords: 'power_records',
  notificationRecords: 'notification_records',
  jobLocks: 'job_locks',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]

export interface QueryResult<T> {
  data: T[]
}

export interface CollectionReference<T> {
  add(options: { data: Record<string, unknown> }): Promise<unknown>
  doc(id: string): DocumentReference
  where(query: Record<string, unknown>): QueryReference<T>
}

export interface DocumentReference {
  set(options: { data: Record<string, unknown> }): Promise<unknown>
  update(options: { data: Record<string, unknown> }): Promise<unknown>
}

export interface QueryReference<T> {
  get(): Promise<QueryResult<T>>
}

export interface DatabaseAdapter {
  collection<T>(name: CollectionName): CollectionReference<T>
  serverDate(): Date
}

export interface CloudContext {
  OPENID?: string
}

export interface CloudSdk {
  DYNAMIC_CURRENT_ENV: string
  database(): DatabaseAdapter
  getWXContext(): CloudContext
  init(options: { env: string }): void
}

declare const require: (name: string) => CloudSdk

const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

export function getDatabase(): DatabaseAdapter {
  return cloud.database()
}

export function getCloudContext(): CloudContext {
  return cloud.getWXContext()
}
