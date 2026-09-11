// clearDatabase 的 TypeScript 类型包装；云函数实际入口仍为同目录 index.js。
export interface ClearDatabaseEvent {
  confirm?: string
}

export interface ClearDatabaseCollectionResult {
  collection: string
  removed: number
  skipped: boolean
}

export interface ClearDatabaseResult {
  ok: boolean
  status: 'server_configuration_required' | 'confirmation_required' | 'cleared' | 'partial_failure'
  message?: string
  totalRemoved?: number
  collections?: ClearDatabaseCollectionResult[]
  failedCollection?: string
  error?: string
}

interface ClearDatabaseRuntime {
  main(event?: ClearDatabaseEvent): Promise<ClearDatabaseResult>
}

declare const require: (name: string) => ClearDatabaseRuntime

const runtime = require('./index.js')

export async function main(event?: ClearDatabaseEvent): Promise<ClearDatabaseResult> {
  return runtime.main(event)
}
