// scheduledCheck 的返回结果类型和 TypeScript 转发入口。
export interface ScheduledCheckResult {
  ok: boolean
  locked?: boolean
  lockDisabled?: boolean
  skipped?: boolean
  reason?: string
  checkedMeters: number
  dueMeters?: number
  plannedMeters?: number
  skippedActiveJobs?: number
  sentNotifications: number
  failedNotifications?: number
  skippedNotifications?: number
  errors?: Array<{
    meterId?: string
    error: string
  }>
}

interface ScheduledCheckRuntime {
  main(): Promise<ScheduledCheckResult>
}

declare const require: (name: string) => ScheduledCheckRuntime

// 定时云函数的生产入口仍是 index.js，这里只提供类型约束。
const runtime = require('./index.js')

export async function main(): Promise<ScheduledCheckResult> {
  return runtime.main()
}
