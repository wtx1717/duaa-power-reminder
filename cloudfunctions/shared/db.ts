// 云函数共享的数据库适配层。
// 集中定义集合名称和最小调用接口，业务模块不必重复初始化 wx-server-sdk。
export const COLLECTIONS = {
  userConfigs: 'user_configs',
  userQueryState: 'user_query_state',
  meters: 'meters',
  powerRecords: 'power_records',
  notificationRecords: 'notification_records',
  meterCheckJobs: 'meter_check_jobs',
  jobLocks: 'job_locks',
  opsDashboardSnapshots: 'ops_dashboard_snapshots',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]

export interface QueryResult<T> {
  // 云开发查询统一返回 data 数组。
  data: T[]
}

export interface CollectionReference<T> {
  add(options: { data: Record<string, unknown> }): Promise<unknown>
  doc(id: string): DocumentReference
  where(query: Record<string, unknown>): QueryReference<T>
}

export interface DocumentReference {
  remove(): Promise<unknown>
  set(options: { data: Record<string, unknown> }): Promise<unknown>
  update(options: { data: Record<string, unknown> }): Promise<unknown>
}

export interface DatabaseCommand {
  remove(): unknown
}

export interface QueryReference<T> {
  get(): Promise<QueryResult<T>>
  update(options: { data: Record<string, unknown> }): Promise<unknown>
}

export interface DatabaseAdapter {
  // 业务代码只依赖这些方法，因此测试时可以注入内存 Mock 数据库。
  collection<T>(name: CollectionName): CollectionReference<T>
  command: DatabaseCommand
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

// 这里使用 require 是为了兼容微信云函数运行时提供的 CommonJS 模块。
const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

export function getDatabase(): DatabaseAdapter {
  // 每次调用都从 SDK 获取当前云函数环境的数据库对象。
  return cloud.database()
}

export function getCloudContext(): CloudContext {
  // OPENID 等调用上下文由微信平台注入，不能由客户端自行传入。
  return cloud.getWXContext()
}
