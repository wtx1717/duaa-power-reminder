import { COLLECTIONS, getCloudContext, getDatabase } from '../shared/db'
import type { DatabaseAdapter } from '../shared/db'
import type { Meter, MeterCheckJob, UserConfig } from '../shared/types'

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

const ACTIVE_JOB_STATUSES = new Set(['pending', 'running'])

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

function getBindingField(type: UnbindTarget['type']): 'lightMeterId' | 'acMeterId' {
  return type === 'ac' ? 'acMeterId' : 'lightMeterId'
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

async function findOtherBindings(
  db: DatabaseAdapter,
  target: UnbindTarget,
  openid: string,
): Promise<Array<UserConfig & StoredDocument>> {
  const field = getBindingField(target.type)

  try {
    const result = await db.collection<UserConfig & StoredDocument>(COLLECTIONS.userConfigs)
      .where({ [field]: target.meterId })
      .get()

    return result.data.filter((config) => Boolean(config.openid) && config.openid !== openid)
  } catch (error) {
    throw new Error(`查询其他用户绑定失败：${getErrorDetails(error)}`)
  }
}

async function getMeter(
  db: DatabaseAdapter,
  meterId: string,
): Promise<(Meter & StoredDocument) | undefined> {
  try {
    const result = await db.collection<Meter & StoredDocument>(COLLECTIONS.meters)
      .where({ meterId })
      .get()
    return result.data[0]
  } catch (error) {
    throw new Error(`查询电表失败：${getErrorDetails(error)}`)
  }
}

async function getMeterJobs(
  db: DatabaseAdapter,
  meterId: string,
): Promise<Array<MeterCheckJob & StoredDocument>> {
  try {
    const result = await db.collection<MeterCheckJob & StoredDocument>(COLLECTIONS.meterCheckJobs)
      .where({ meterId })
      .get()
    return result.data
  } catch (error) {
    if (isCollectionNotFoundError(error)) {
      return []
    }

    throw new Error(`查询调度任务失败：${getErrorDetails(error)}`)
  }
}

async function updateMeter(
  db: DatabaseAdapter,
  meter: Meter & StoredDocument,
  data: Record<string, unknown>,
): Promise<void> {
  if (!meter._id) {
    return
  }

  try {
    await db.collection<Meter & StoredDocument>(COLLECTIONS.meters).doc(meter._id).update({ data })
  } catch (error) {
    throw new Error(`电表清理失败：${getErrorDetails(error)}`)
  }
}

async function expirePendingJobs(
  db: DatabaseAdapter,
  jobs: Array<MeterCheckJob & StoredDocument>,
): Promise<number> {
  let expiredJobs = 0

  try {
    for (const job of jobs) {
      if (job.status !== 'pending' || !job._id) {
        continue
      }

      await db.collection<MeterCheckJob & StoredDocument>(COLLECTIONS.meterCheckJobs)
        .doc(job._id)
        .update({
          data: {
            status: 'expired',
            error: '电表已解绑',
            finishedAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
      expiredJobs += 1
    }
  } catch (error) {
    throw new Error(`调度任务处理失败：${getErrorDetails(error)}`)
  }

  return expiredJobs
}

async function markCleanupPending(
  db: DatabaseAdapter,
  meter: Meter & StoredDocument,
): Promise<void> {
  await updateMeter(db, meter, {
    cleanupPending: true,
    cleanupReason: '电表已解绑，存在运行中的调度任务',
    updatedAt: db.serverDate(),
  })
}

async function removeMeter(
  db: DatabaseAdapter,
  meter: Meter & StoredDocument,
): Promise<void> {
  if (!meter._id) {
    return
  }

  try {
    await db.collection<Meter & StoredDocument>(COLLECTIONS.meters).doc(meter._id).remove()
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return
    }

    throw new Error(`电表清理失败：${getErrorDetails(error)}`)
  }
}

async function cleanMeter(
  db: DatabaseAdapter,
  target: UnbindTarget,
  openid: string,
): Promise<{ action: 'cleaned' | 'retained' | 'cleanup_pending'; expiredJobs: number }> {
  let otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs: 0 }
  }

  const meter = await getMeter(db, target.meterId)
  if (!meter) {
    return { action: 'cleaned', expiredJobs: 0 }
  }

  let jobs = await getMeterJobs(db, target.meterId)
  if (jobs.some((job) => job.status === 'running')) {
    otherBindings = await findOtherBindings(db, target, openid)
    if (otherBindings.length) {
      return { action: 'retained', expiredJobs: 0 }
    }

    const expiredJobs = await expirePendingJobs(db, jobs)
    await markCleanupPending(db, meter)
    return { action: 'cleanup_pending', expiredJobs }
  }

  otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs: 0 }
  }

  const expiredJobs = await expirePendingJobs(db, jobs)
  jobs = await getMeterJobs(db, target.meterId)

  otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs }
  }

  if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))) {
    await markCleanupPending(db, meter)
    return { action: 'cleanup_pending', expiredJobs }
  }

  const finalMeter = await getMeter(db, target.meterId)
  if (!finalMeter) {
    return { action: 'cleaned', expiredJobs }
  }

  otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs }
  }

  await removeMeter(db, finalMeter)
  return { action: 'cleaned', expiredJobs }
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
