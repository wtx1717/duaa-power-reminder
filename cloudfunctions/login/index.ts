import { COLLECTIONS, getCloudContext, getDatabase } from '../shared/db'
import type { Meter, UserConfig } from '../shared/types'

export interface LoginResult {
  openid: string
  config?: UserConfig
  meters?: {
    light?: Meter
    ac?: Meter
  }
}

async function getMeterById(meterId?: string): Promise<Meter | undefined> {
  if (!meterId) {
    return undefined
  }

  const db = getDatabase()
  const result = await db.collection<Meter>(COLLECTIONS.meters).where({ meterId }).get()
  return result.data[0]
}

export async function main(): Promise<LoginResult> {
  const { OPENID } = getCloudContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  const db = getDatabase()
  const result = await db.collection<UserConfig>(COLLECTIONS.userConfigs).where({
    openid: OPENID,
  }).get()
  const config = result.data[0]

  return {
    openid: OPENID,
    config,
    meters: {
      light: await getMeterById(config?.lightMeterId),
      ac: await getMeterById(config?.acMeterId),
    },
  }
}
