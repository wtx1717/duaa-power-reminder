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