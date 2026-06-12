import type { Meter, PowerQueryResult } from './types'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export function calculateNextCheckAt(
  _meter: Meter,
  _latestResult: PowerQueryResult,
  now = new Date(),
): Date {
  // TODO: Replace with usage-aware scheduling after enough power history is collected.
  return new Date(now.getTime() + ONE_DAY_MS)
}
