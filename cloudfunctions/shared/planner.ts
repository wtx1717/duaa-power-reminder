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
  if (!latestResult.ok || latestResult.remainingKwh === undefined) {
    return new Date(now.getTime() + ONE_DAY_MS)
  }

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
  const usage = Number(value)

  if (!Number.isFinite(usage) || usage <= 0) {
    return DEFAULT_ESTIMATED_DAILY_USAGE_KWH
  }

  return usage
}
