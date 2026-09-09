// meterCleanup.js 的 TypeScript 声明文件。
// 运行时代码使用 CommonJS 导出，这里只描述 cleanMeter 的参数和结果。
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
