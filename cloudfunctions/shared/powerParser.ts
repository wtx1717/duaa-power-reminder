// 上游电量页面解析的 TypeScript 接口占位。
// 实际生产解析器目前在 queryPower/index.js 和 scheduledExecutor.js 中实现。
import type { PowerQueryResult } from './types'

export function parsePowerPage(
  meterId: string,
  _html: string,
  queriedAt = new Date(),
): PowerQueryResult {
  // 待办：后续需要从电量页面 HTML 中解析剩余电量、预计断电时间和地址。
  return {
    meterId,
    ok: false,
    error: 'Power page parser is not implemented',
    queriedAt,
  }
}
