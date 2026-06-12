export interface ScheduledCheckResult {
  ok: boolean
  locked?: boolean
  lockDisabled?: boolean
  checkedMeters: number
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

const runtime = require('./index.js')

export async function main(): Promise<ScheduledCheckResult> {
  return runtime.main()
}
