// 每日运营快照云函数的类型包装。
import type { OpsDashboardSnapshotDocument } from '../shared/types'

export interface ScheduledDashboardSnapshotResult {
  // 快照任务向平台或测试脚本返回的摘要，而不是完整快照正文。
  ok: boolean
  snapshotDate: string
  status: OpsDashboardSnapshotDocument['status']
  replaced: boolean
  meterCount: number
  powerRecordCount: number
  notificationRecordCount: number
  jobRecordCount: number
  error?: string
}

interface ScheduledDashboardSnapshotRuntime {
  main(event?: { snapshotDate?: string }): Promise<ScheduledDashboardSnapshotResult>
}

declare const require: (name: string) => ScheduledDashboardSnapshotRuntime

// index.js 是云函数实际入口，本文件只提供类型安全的调用接口。
const runtime = require('./index.js')

export async function main(
  event?: { snapshotDate?: string },
): Promise<ScheduledDashboardSnapshotResult> {
  return runtime.main(event)
}
