import type { PowerQueryResult, QueryPowerInput } from '../shared/types'

export async function main(event: QueryPowerInput): Promise<PowerQueryResult> {
  // TODO: Fetch, parse, and persist one meter power query result.
  return {
    meterId: event.meterId,
    ok: false,
    error: 'queryPower is not implemented',
    queriedAt: new Date(),
  }
}
