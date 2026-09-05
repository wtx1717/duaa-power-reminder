export type MeterType = 'light' | 'ac'
export type MeterScheduleMode = 'normal' | 'near_threshold' | 'notified'

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped'
export type PowerRecordSource = 'queryPower' | 'scheduledCheck'
export type OpsDashboardSnapshotStatus = 'success' | 'partial' | 'failed'

export interface UserConfig {
  _id?: string
  openid: string
  lightMeterId: string
  acMeterId: string
  email: string
  reminderEnabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface UserQueryState {
  _id?: string
  openid: string
  lastManualLightQueryAt: Date
  manualLightQueryLockUntil: Date
  lastManualAcQueryAt: Date
  manualAcQueryLockUntil: Date
  createdAt: Date
  updatedAt: Date
}

export interface Meter {
  _id?: string
  meterId: string
  type: MeterType
  lastRemainingKwh?: number
  lastQueriedAt?: Date
  nextCheckAt?: Date
  checkIntervalMinutes?: number
  estimatedDailyUsageKwh?: number
  scheduleMode?: MeterScheduleMode
  lastRechargeDetectedAt?: Date
  lowPowerNotifiedAt?: Date
  cleanupPending?: boolean
  cleanupReason?: string
  failCount: number
  lastError?: string
  createdAt: Date
  updatedAt: Date
}

export interface PowerQueryResult {
  meterId: string
  remainingKwh?: number
  cutoffTime?: string
  address?: string
  ok: boolean
  error?: string
  queriedAt: Date
}

export interface PowerRecord extends PowerQueryResult {
  _id?: string
  type?: MeterType
  source?: PowerRecordSource
}

export interface NotificationRecord {
  _id?: string
  openid: string
  email?: string
  meterId: string
  type?: MeterType
  channel?: 'email'
  remainingKwh: number
  thresholdKwh: number
  sentAt: Date
  status: NotificationStatus
  source?: 'queryPower' | 'scheduledCheck'
  error?: string
}

export interface JobLock {
  _id?: string
  name: string
  lockedUntil: Date
  owner: string
  updatedAt: Date
}

export type MeterCheckJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'expired'

export interface MeterCheckJob {
  _id?: string
  meterDocId?: string
  meterId: string
  type: MeterType
  status: MeterCheckJobStatus
  runId: string
  plannedAt: Date
  deadlineAt: Date
  attempts?: number
  error?: string
  createdAt: Date
  updatedAt: Date
  startedAt?: Date
  finishedAt?: Date
}

export interface SaveConfigInput {
  lightMeterId: string
  acMeterId: string
  email: string
  reminderEnabled: boolean
}

export interface QueryPowerInput {
  meterId: string
  type: MeterType
}

export interface OpsDashboardSnapshotStateCount {
  normal: number
  warn: number
  monitor: number
  error: number
}

export interface OpsDashboardSnapshotKpi {
  label: string
  value: string
  foot: string
}

export interface OpsDashboardSnapshotSummaryItem {
  key: keyof OpsDashboardSnapshotStateCount
  title: string
  count: number
  note: string
}

export interface OpsDashboardSnapshotMeter {
  meterId: string
  type: MeterType
  typeText: string
  state: keyof OpsDashboardSnapshotStateCount
  stateText: string
  currentKwh: number | null
  currentText: string
  dailyUsageKwh: number | null
  dailyText: string
  failCount: number
  nextCheckAt: string
  queriedAt: string
  scheduleMode: MeterScheduleMode
  lastError: string
  latestAddress: string
  latestCutoffTime: string
  queryCount: number
  notifyCount: number
}

export interface OpsDashboardSnapshotPowerRecord {
  meterId: string
  type: MeterType
  remainingKwh?: number
  cutoffTime?: string
  address?: string
  ok: boolean
  error?: string
  queriedAt: string
  source: PowerRecordSource
}

export interface OpsDashboardSnapshotNotificationRecord {
  meterId: string
  type: MeterType
  remainingKwh: number
  thresholdKwh: number
  sentAt: string
  status: NotificationStatus
  channel: 'email'
  source: 'queryPower' | 'scheduledCheck'
  email?: string
  error?: string
}

export interface OpsDashboardSnapshotJobRecord {
  jobId: string
  meterId: string
  type: MeterType
  status: MeterCheckJobStatus
  statusText: string
  runId: string
  plannedAt: string
  startedAt: string
  finishedAt: string
  attempts: number
  error: string
}

export interface OpsDashboardSnapshotDocument {
  _id?: string
  snapshotDate: string
  generatedAt: string
  timeZone: string
  status: OpsDashboardSnapshotStatus
  note?: string
  sourceWindow: {
    startAt: string
    endAt: string
  }
  userCount: number
  meterCount: number
  powerRecordCount: number
  notificationRecordCount: number
  jobRecordCount: number
  completedJobCount: number
  failedJobCount: number
  completionRate: number
  stateCounts: OpsDashboardSnapshotStateCount
  kpis: OpsDashboardSnapshotKpi[]
  summary: OpsDashboardSnapshotSummaryItem[]
  meters: OpsDashboardSnapshotMeter[]
  powerRecords: OpsDashboardSnapshotPowerRecord[]
  notificationRecords: OpsDashboardSnapshotNotificationRecord[]
  jobRecords: OpsDashboardSnapshotJobRecord[]
}
