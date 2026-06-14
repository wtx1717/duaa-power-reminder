export type MeterType = 'light' | 'ac'

export type SubscribeStatus = 'unknown' | 'accepted' | 'rejected'
export type NotificationSubscribeStatus = 'accepted' | 'rejected' | 'skipped'

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface UserConfig {
  _id?: string
  openid: string
  lightMeterId: string
  acMeterId: string
  thresholdKwh: number
  reminderEnabled: boolean
  subscribeStatus: SubscribeStatus
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
}

export interface NotificationRecord {
  _id?: string
  openid: string
  meterId: string
  remainingKwh: number
  thresholdKwh: number
  sentAt: Date
  status: NotificationStatus
  error?: string
}

export interface JobLock {
  _id?: string
  name: string
  lockedUntil: Date
  owner: string
  updatedAt: Date
}

export interface SaveConfigInput {
  lightMeterId: string
  acMeterId: string
  thresholdKwh: number
  reminderEnabled: boolean
  nextCheckAt?: Date | string
  checkIntervalMinutes?: number | string
  notificationSubscribeStatus?: SubscribeStatus
}

export interface QueryPowerInput {
  meterId: string
  type: MeterType
  notificationSubscribeStatus?: NotificationSubscribeStatus
}
