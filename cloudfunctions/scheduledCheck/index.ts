export interface ScheduledCheckResult {
  ok: boolean
  checkedMeters: number
  sentNotifications: number
}

export async function main(): Promise<ScheduledCheckResult> {
  // TODO: Acquire job lock, query due meters, update planner, and create notification records.
  return {
    ok: false,
    checkedMeters: 0,
    sentNotifications: 0,
  }
}
