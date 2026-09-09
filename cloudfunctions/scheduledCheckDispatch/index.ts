// scheduledCheckDispatch 的返回结果类型和 TypeScript 转发入口。
export interface ScheduledCheckDispatchResult {
  ok: boolean
  skipped?: boolean
  reason?: string
  checkedMeters: number
  failedJobs: number
  expiredJobs: number
  sentNotifications: number
  failedNotifications?: number
  skippedNotifications?: number
  errors?: Array<{
    jobId?: string
    meterId?: string
    error: string
  }>
}

interface ScheduledCheckDispatchRuntime {
  main(): Promise<ScheduledCheckDispatchResult>
}

declare const require: (name: string) => ScheduledCheckDispatchRuntime

// 运行逻辑集中在 index.js，避免任务分发代码维护两份。
const runtime = require('./index.js')

export async function main(): Promise<ScheduledCheckDispatchResult> {
  return runtime.main()
}
