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

const runtime = require('./index.js')

export async function main(): Promise<ScheduledCheckDispatchResult> {
  return runtime.main()
}
