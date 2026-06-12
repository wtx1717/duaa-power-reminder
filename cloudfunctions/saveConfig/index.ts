import type { SaveConfigInput } from '../shared/types'

export interface SaveConfigResult {
  ok: boolean
}

export async function main(_event: SaveConfigInput): Promise<SaveConfigResult> {
  // TODO: Validate meter ids and upsert user_configs plus meters documents.
  return {
    ok: false,
  }
}
