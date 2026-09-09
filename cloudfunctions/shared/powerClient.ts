// 上游电量页面请求的抽象接口。
// 当前真实运行逻辑位于各云函数的 index.js；这里保留类型化接口供 TypeScript 层使用。
import type { QueryPowerInput } from './types'

export interface PowerPageResponse {
  meterId: string
  html: string
  fetchedAt: Date
}

export async function fetchPowerPage(_input: QueryPowerInput): Promise<PowerPageResponse> {
  // 待办：后续需要在云函数运行环境中请求北航电量页面。
  throw new Error('Power page request is not implemented')
}
