export type MeterType = 'light' | 'ac'

export type SubscribeStatus = 'unknown' | 'accepted' | 'rejected'
export type NotificationSubscribeStatus = 'accepted' | 'rejected' | 'skipped'

export interface UserPowerConfig {
  openid: string
  lightMeterId: string
  acMeterId: string
  thresholdKwh: number
  reminderEnabled: boolean
  subscribeStatus: SubscribeStatus
  createdAt?: string
  updatedAt?: string
}

export interface MeterSnapshot {
  meterId: string
  type: MeterType
  lastRemainingKwh?: number
  lastQueriedAt?: string
  remainingKwh?: number
  nextCheckAt?: string
  checkIntervalMinutes?: number
}

export interface SaveConfigPayload {
  lightMeterId: string
  acMeterId: string
  thresholdKwh: number
  reminderEnabled: boolean
  nextCheckAt?: string
  checkIntervalMinutes?: number
}

export interface SaveConfigResult {
  ok: boolean
  config?: UserPowerConfig
  error?: string
}

export interface LoginResult {
  openid: string
  config?: UserPowerConfig
  meters?: {
    light?: MeterSnapshot
    ac?: MeterSnapshot
  }
}

export interface QueryPowerPayload {
  meterId: string
  type: MeterType
  notificationSubscribeStatus?: NotificationSubscribeStatus
}

export interface QueryPowerResult {
  meterId: string
  remainingKwh?: number
  cutoffTime?: string
  address?: string
  ok: boolean
  error?: string
  queriedAt: string
}

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

export interface MeterPowerView {
  label: string
  meterId: string
  loading: boolean
  displayText?: string
  result?: QueryPowerResult
}
