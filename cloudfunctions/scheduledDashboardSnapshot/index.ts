import type { OpsDashboardSnapshotDocument } from '../shared/types'

export interface ScheduledDashboardSnapshotResult {
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

const runtime = require('./index.js')

export async function main(
  event?: { snapshotDate?: string },
): Promise<ScheduledDashboardSnapshotResult> {
  return runtime.main(event)
}
