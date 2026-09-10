// 小程序端的领域类型。
// 这些接口描述云函数和页面之间传递的数据形状，不会在运行时生成代码。
export type MeterType = 'light' | 'ac'
export type MeterScheduleMode = 'normal' | 'near_threshold' | 'notified'

export interface UserPowerConfig {
  // 用户绑定的两块电表和提醒邮箱。
  openid: string
  lightMeterId: string
  acMeterId: string
  email: string
  reminderEnabled: boolean
  createdAt?: string
  updatedAt?: string
}

export interface MeterSnapshot {
  // 登录接口返回的电表状态快照；日期在小程序端以 ISO 字符串表示。
  meterId: string
  type: MeterType
  lastRemainingKwh?: number
  lastQueriedAt?: string
  remainingKwh?: number
  nextCheckAt?: string
  checkIntervalMinutes?: number
  estimatedDailyUsageKwh?: number
  scheduleMode?: MeterScheduleMode
  isColdStart?: boolean
  cleanupPending?: boolean
  cleanupReason?: string
  lastRechargeDetectedAt?: string
  lowPowerNotifiedAt?: string
}

export interface SaveConfigPayload {
  lightMeterId: string
  acMeterId: string
  email: string
  reminderEnabled: boolean
}

export interface SaveConfigResult {
  ok: boolean
  config?: UserPowerConfig
  error?: string
}

export interface UnbindConfigResult {
  ok: boolean
  status: 'unbound' | 'already_unbound'
  cleanedMeters?: string[]
  retainedMeters?: string[]
  expiredJobs?: number
  cleanupPendingMeters?: string[]
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
  skipped?: boolean
  reason?: string
  checkedMeters: number
  dueMeters?: number
  plannedMeters?: number
  skippedActiveJobs?: number
  sentNotifications: number
  failedNotifications?: number
  skippedNotifications?: number
  errors?: Array<{
    meterId?: string
    error: string
  }>
}

export interface MeterPowerView {
  // 首页中一块电表的显示状态，包含加载中、展示文案和原始查询结果。
  label: string
  meterId: string
  loading: boolean
  displayText?: string
  result?: QueryPowerResult
}
