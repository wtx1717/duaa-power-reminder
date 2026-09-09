// login 云函数的 TypeScript 类型层。
// 真正执行逻辑在同目录 index.js，本文件提供可检查的输入输出接口和转发入口。
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
  // 没有绑定编号时不访问数据库，返回 undefined 表示该类型没有配置。
  if (!meterId) {
    return undefined
  }

  const db = getDatabase()
  const result = await db.collection<Meter>(COLLECTIONS.meters).where({ meterId }).get()
  return result.data[0]
}

function toPublicConfig(config?: UserConfig): UserConfig | undefined {
  // 只返回客户端需要的字段，避免把服务端内部字段直接暴露给小程序。
  if (!config) {
    return undefined
  }

  return {
    openid: config.openid,
    lightMeterId: config.lightMeterId,
    acMeterId: config.acMeterId,
    email: config.email,
    reminderEnabled: config.reminderEnabled,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }
}

export async function main(): Promise<LoginResult> {
  // 从微信云函数上下文读取当前用户，而不是相信客户端传来的 openid。
  const { OPENID } = getCloudContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  const db = getDatabase()
  const result = await db.collection<UserConfig>(COLLECTIONS.userConfigs).where({
    openid: OPENID,
  }).get()
  const config = toPublicConfig(result.data[0])

  return {
    openid: OPENID,
    config,
    meters: {
      light: await getMeterById(config ? config.lightMeterId : undefined),
      ac: await getMeterById(config ? config.acMeterId : undefined),
    },
  }
}
