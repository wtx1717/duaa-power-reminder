// unbindConfig 的 TypeScript 业务实现。
// 解绑会删除用户配置和手动查询锁，但会根据共享关系决定是否删除电表。
import { COLLECTIONS, getCloudContext, getDatabase } from '../shared/db'
import type { DatabaseAdapter } from '../shared/db'
import { cleanMeter } from './shared/meterCleanup'
import type { UserConfig } from '../shared/types'

interface StoredDocument {
  _id?: string
}

interface UnbindTarget {
  meterId: string
  type: 'light' | 'ac'
}

export interface UnbindConfigResult {
  ok: boolean
  status: 'unbound' | 'already_unbound'
  cleanedMeters: string[]
  retainedMeters: string[]
  cleanupPendingMeters: string[]
  expiredJobs: number
  error?: string
}

function getErrorDetails(error: unknown): string {
  // SDK 可能返回 Error、字符串或普通错误对象，统一转换后再包装业务错误。
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const value = error as {
      code?: unknown
      errCode?: unknown
      errMsg?: unknown
      errorCode?: unknown
      message?: unknown
    }
    const fields = [
      value.code,
      value.errCode,
      value.errorCode,
      value.message,
      value.errMsg,
    ].filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')

    if (fields.length) {
      return fields.join(' ')
    }
  }

  try {
    return JSON.stringify(error)
  } catch (_serializationError) {
    return String(error)
  }
}

function isCollectionNotFoundError(error: unknown): boolean {
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist|meter_check_jobs/i.test(
    getErrorDetails(error),
  )
}

function isDocumentNotFoundError(error: unknown): boolean {
  return /DATABASE_DOCUMENT_NOT_EXIST|document not exist|document does not exist|document not found/i.test(
    getErrorDetails(error),
  )
}

function normalizeMeterId(value: unknown): string {
  return String(value || '').trim()
}

async function getUserConfigs(
  db: DatabaseAdapter,
  openid: string,
): Promise<Array<UserConfig & StoredDocument>> {
  // 一个用户理论上只有一条配置，但这里读取全部记录，兼容历史重复数据。
  try {
    const result = await db.collection<UserConfig & StoredDocument>(COLLECTIONS.userConfigs)
      .where({ openid })
      .get()
    return result.data
  } catch (error) {
    throw new Error(`查询用户配置失败：${getErrorDetails(error)}`)
  }
}

function collectTargets(configs: Array<UserConfig & StoredDocument>): UnbindTarget[] {
  // 以“类型 + 电表号”去重，避免历史重复配置导致重复清理。
  const targets: UnbindTarget[] = []
  const seen = new Set<string>()

  for (const config of configs) {
    for (const type of ['light', 'ac'] as const) {
      const meterId = normalizeMeterId(config[type === 'light' ? 'lightMeterId' : 'acMeterId'])
      const key = `${type}:${meterId}`

      if (meterId && !seen.has(key)) {
        seen.add(key)
        targets.push({ meterId, type })
      }
    }
  }

  return targets
}

async function deleteUserConfigs(
  db: DatabaseAdapter,
  configs: Array<UserConfig & StoredDocument>,
): Promise<void> {
  // 删除用户配置；记录已经不存在时视为幂等成功。
  try {
    for (const config of configs) {
      if (config._id) {
        try {
          await db.collection<UserConfig & StoredDocument>(COLLECTIONS.userConfigs)
            .doc(config._id)
            .remove()
        } catch (error) {
          if (!isDocumentNotFoundError(error)) {
            throw error
          }
        }
      }
    }
  } catch (error) {
    throw new Error(`删除用户配置失败：${getErrorDetails(error)}`)
  }
}

async function deleteUserQueryState(
  db: DatabaseAdapter,
  openid: string,
): Promise<void> {
  // 删除手动查询限流状态；集合不存在时说明系统尚未创建过该状态，可忽略。
  try {
    const result = await db.collection<{ _id?: string } & StoredDocument>(COLLECTIONS.userQueryState)
      .where({ openid })
      .get()

    for (const item of result.data) {
      if (item._id) {
        try {
          await db.collection(COLLECTIONS.userQueryState).doc(item._id).remove()
        } catch (error) {
          if (!isDocumentNotFoundError(error)) {
            throw error
          }
        }
      }
    }
  } catch (error) {
    if (!isCollectionNotFoundError(error)) {
      throw new Error(`删除手动查询状态失败：${getErrorDetails(error)}`)
    }
  }
}

export async function main(): Promise<UnbindConfigResult> {
  // 解绑必须使用微信上下文中的 openid，不能让客户端指定要删除的用户。
  const { OPENID } = getCloudContext()

  if (!OPENID) {
    throw new Error('无法获取当前用户身份')
  }

  const db = getDatabase()
  const configs = await getUserConfigs(db, OPENID)

  if (!configs.length) {
    return {
      ok: true,
      status: 'already_unbound',
      cleanedMeters: [],
      retainedMeters: [],
      cleanupPendingMeters: [],
      expiredJobs: 0,
    }
  }

  const targets = collectTargets(configs)
  await deleteUserConfigs(db, configs)
  await deleteUserQueryState(db, OPENID)

  const cleanedMeters: string[] = []
  const retainedMeters: string[] = []
  const cleanupPendingMeters: string[] = []
  let expiredJobs = 0

  for (const target of targets) {
    const result = await cleanMeter(db, target, OPENID)
    expiredJobs += result.expiredJobs

    if (result.action === 'cleaned') {
      cleanedMeters.push(target.meterId)
    } else if (result.action === 'cleanup_pending') {
      cleanupPendingMeters.push(target.meterId)
    } else {
      retainedMeters.push(target.meterId)
    }
  }

  return {
    ok: true,
    status: 'unbound',
    cleanedMeters: Array.from(new Set(cleanedMeters)),
    retainedMeters: Array.from(new Set(retainedMeters)),
    cleanupPendingMeters: Array.from(new Set(cleanupPendingMeters)),
    expiredJobs,
  }
}
