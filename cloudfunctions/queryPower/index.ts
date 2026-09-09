// queryPower 的 TypeScript 类型包装。
// 业务实现保留在 index.js，因为微信云函数 package.json 的入口就是 JavaScript 文件。
import type { PowerQueryResult, QueryPowerInput } from '../shared/types'

interface QueryPowerRuntime {
  main(event: QueryPowerInput): Promise<PowerQueryResult>
}

declare const require: (name: string) => QueryPowerRuntime

// require 返回运行时模块；这里不重复实现逻辑，避免 TS 和 JS 两份代码分叉。
const runtime = require('./index.js')

export async function main(event: QueryPowerInput): Promise<PowerQueryResult> {
  // 把类型检查后的参数原样转交给 JavaScript 运行层。
  return runtime.main(event)
}
