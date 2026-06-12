import type { PowerQueryResult } from './types'

export function parsePowerPage(
  meterId: string,
  _html: string,
  queriedAt = new Date(),
): PowerQueryResult {
  // TODO: Parse remaining kWh, cutoff time, and address from the power page HTML.
  return {
    meterId,
    ok: false,
    error: 'Power page parser is not implemented',
    queriedAt,
  }
}
