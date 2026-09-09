// 基础巡检时间计算逻辑。
// 复杂的任务分发在 scheduledPlanner.js 中；本文件负责根据电量和日耗估算下次检查时间。
import type { Meter, PowerQueryResult } from './types'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_ESTIMATED_DAILY_USAGE_KWH = 5
const SAFETY_MARGIN_DAYS = 2
const NEAR_THRESHOLD_BAND_KWH = 5
const DEFAULT_REMINDER_THRESHOLD_KWH = 20

export interface ScheduleComputationInput {
  meter: Meter
  latestResult: PowerQueryResult
  now?: Date
}

export function calculateNextCheckAt(
  meter: Meter,
  latestResult: PowerQueryResult,
  now = new Date(),
): Date {
  // 查询失败或没有电量时无法估算剩余天数，退回一天后重试。
  if (!latestResult.ok || latestResult.remainingKwh === undefined) {
    return new Date(now.getTime() + ONE_DAY_MS)
  }

  // distance 表示距离提醒阈值还剩多少电量，而不是距离 0 度还剩多少。
  const distanceToThreshold = latestResult.remainingKwh - DEFAULT_REMINDER_THRESHOLD_KWH

  if (distanceToThreshold <= NEAR_THRESHOLD_BAND_KWH) {
    return new Date(now.getTime() + ONE_DAY_MS)
  }

  const usage = normalizeEstimatedDailyUsageKwh(meter.estimatedDailyUsageKwh)
  const daysUntilThreshold = distanceToThreshold / usage
  const daysUntilNextCheck = Math.max(1, daysUntilThreshold - SAFETY_MARGIN_DAYS)
  return new Date(now.getTime() + daysUntilNextCheck * ONE_DAY_MS)
}

function normalizeEstimatedDailyUsageKwh(value: unknown): number {
  // 数据库中的旧数据可能为空、字符串或非法数字，统一回退到默认日耗。
  const usage = Number(value)

  if (!Number.isFinite(usage) || usage <= 0) {
    return DEFAULT_ESTIMATED_DAILY_USAGE_KWH
  }

  return usage
}
