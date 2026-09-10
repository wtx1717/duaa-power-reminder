// 云函数端共享领域类型。
// 类型只用于编译期约束；数据库中的真实字段仍由各云函数写入。
export type MeterType = 'light' | 'ac'
export type MeterScheduleMode = 'normal' | 'near_threshold' | 'notified'

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped'
export type PowerRecordSource = 'queryPower' | 'scheduledCheck'
export type OpsDashboardSnapshotStatus = 'success' | 'partial' | 'failed'

export interface UserConfig {
  // 一个用户的电表绑定和邮件提醒配置。
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
  // 手动查询限流状态；每种电表分别保存上次查询时间和锁定截止时间。
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
  // 电表当前状态和定时巡检所需的调度字段。
  _id?: string
  meterId: string
  type: MeterType
  lastRemainingKwh?: number
  lastQueriedAt?: Date
  nextCheckAt?: Date
  checkIntervalMinutes?: number
  estimatedDailyUsageKwh?: number
  scheduleMode?: MeterScheduleMode
  // 缺失时由调度执行器按冷启动处理；首次有效日耗更新后置为 false。
  isColdStart?: boolean
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
  // 一次上游电量页面查询的标准化结果。
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
  // 低电量邮件通知的审计记录，用于去重、排查和看板统计。
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
  // 定时巡检任务从“待执行”到“完成/失败/过期”的状态记录。
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
  // 快照始终输出布尔值；数据库缺失字段时由快照生成器归一为 true。
  isColdStart: boolean
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
  // 每日运营快照的完整结构；看板脚本直接消费其中的汇总和明细。
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
