import type { QueryPowerInput } from './types'

export interface PowerPageResponse {
  meterId: string
  html: string
  fetchedAt: Date
}

export async function fetchPowerPage(_input: QueryPowerInput): Promise<PowerPageResponse> {
  // TODO: Request the BUAA power page from cloud function runtime.
  throw new Error('Power page request is not implemented')
}
