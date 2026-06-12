export type MeterType = 'light' | 'ac'

export type SubscribeStatus = 'unknown' | 'accepted' | 'rejected'

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
  remainingKwh?: number
  lastQueriedAt?: string
  nextCheckAt?: string
}

export interface SaveConfigPayload {
  lightMeterId: string
  acMeterId: string
  thresholdKwh: number
  reminderEnabled: boolean
}

export interface SaveConfigResult {
  ok: boolean
  config?: UserPowerConfig
  error?: string
}

export interface LoginResult {
  openid: string
  config?: UserPowerConfig
}

export interface QueryPowerPayload {
  meterId: string
  type: MeterType
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

export interface MeterPowerView {
  label: string
  meterId: string
  loading: boolean
  displayText?: string
  result?: QueryPowerResult
}
