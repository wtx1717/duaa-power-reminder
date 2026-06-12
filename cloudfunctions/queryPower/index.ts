import type { PowerQueryResult, QueryPowerInput } from '../shared/types'

interface QueryPowerRuntime {
  main(event: QueryPowerInput): Promise<PowerQueryResult>
}

declare const require: (name: string) => QueryPowerRuntime

const runtime = require('./index.js')

export async function main(event: QueryPowerInput): Promise<PowerQueryResult> {
  return runtime.main(event)
}
