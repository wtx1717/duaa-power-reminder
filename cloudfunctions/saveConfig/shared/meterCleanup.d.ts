import type { DatabaseAdapter } from './db'
import type { MeterType } from './types'

export interface CleanupTarget {
  meterId: string
  type: MeterType
}

export interface CleanupResult {
  action: 'cleaned' | 'retained' | 'cleanup_pending'
  expiredJobs: number
}

export function cleanMeter(
  db: DatabaseAdapter,
  target: CleanupTarget,
  openid: string,
): Promise<CleanupResult>
