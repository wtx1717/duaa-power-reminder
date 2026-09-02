export type MeterType = 'light' | 'ac'
export type MeterScheduleMode = 'normal' | 'near_threshold' | 'notified'

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped'
export type PowerRecordSource = 'queryPower' | 'scheduledCheck'

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
