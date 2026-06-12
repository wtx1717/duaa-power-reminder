import { COLLECTIONS, getCloudContext, getDatabase } from '../shared/db'
import type { UserConfig } from '../shared/types'

export interface LoginResult {
  openid: string
  config?: UserConfig
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

  return {
    openid: OPENID,
    config: result.data[0],
  }
}
