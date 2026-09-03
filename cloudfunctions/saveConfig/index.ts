import { COLLECTIONS, getCloudContext, getDatabase } from '../shared/db'
import type { DatabaseAdapter } from '../shared/db'
import type { Meter, SaveConfigInput, UserConfig } from '../shared/types'

export interface SaveConfigResult {
  ok: boolean
  config?: Omit<UserConfig, '_id' | 'createdAt' | 'updatedAt'> & {
    createdAt?: Date
    updatedAt?: Date
  }
  error?: string
}

interface StoredDocument {
  _id?: string
}

type ValidatedSaveConfigInput = Pick<
  SaveConfigInput,
  'lightMeterId' | 'acMeterId' | 'email' | 'reminderEnabled'
>

const DEFAULT_CHECK_INTERVAL_MINUTES = 10
const DEFAULT_ESTIMATED_DAILY_USAGE_KWH = 5
const DEFAULT_SCHEDULE_MODE = 'normal'

function normalizeMeterId(value: string): string {
  return String(value || '').trim()
}

function normalizeEmail(value: string): string {
  return String(value || '').trim().toLowerCase()
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function validateInput(input: SaveConfigInput): ValidatedSaveConfigInput {
  const lightMeterId = normalizeMeterId(input.lightMeterId)
  const acMeterId = normalizeMeterId(input.acMeterId)
  const email = normalizeEmail(input.email)

  if (!lightMeterId) {
    throw new Error('请填写宿舍照明电表号')
  }

  if (!acMeterId) {
    throw new Error('请填写宿舍空调电表号')
  }

  if (lightMeterId === acMeterId) {
    throw new Error('照明电表号和空调电表号不能相同')
  }

  if (!email) {
    throw new Error('请填写提醒邮箱')
  }

  if (!isValidEmail(email)) {
    throw new Error('提醒邮箱格式不正确')
  }

  return {
    lightMeterId,
    acMeterId,
    email,
    reminderEnabled: true,
  }
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

export function isDuplicateKeyError(error: unknown): boolean {
  const details = getErrorDetails(error)
  return /E11000|DUPLICATE[_\s-]*KEY|duplicate\s+key|duplicate\s+key\s+error|duplicate.*(?:index|unique)|unique.*(?:index|constraint|key)|唯一.*(?:索引|键)|(?:索引|键).*唯一/i.test(details)
}

function buildExistingMeterData(
  current: (Meter & StoredDocument) | undefined,
  type: Meter['type'],
  updatedAt: Date,
): Record<string, unknown> {
  const estimatedDailyUsageKwh = current && Number.isFinite(Number(current.estimatedDailyUsageKwh))
    ? Number(current.estimatedDailyUsageKwh)
    : DEFAULT_ESTIMATED_DAILY_USAGE_KWH
  return {
    type,
    checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
    estimatedDailyUsageKwh,
    scheduleMode: current && current.scheduleMode ? current.scheduleMode : DEFAULT_SCHEDULE_MODE,
    updatedAt,
  }
}

export async function upsertMeter(
  db: DatabaseAdapter,
  meterId: string,
  type: Meter['type'],
): Promise<void> {
  const now = db.serverDate()
  const meters = db.collection<Meter & StoredDocument>(COLLECTIONS.meters)
  try {
    await meters.add({
      data: {
        meterId,
        type,
        failCount: 0,
        nextCheckAt: new Date(),
        checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
        estimatedDailyUsageKwh: DEFAULT_ESTIMATED_DAILY_USAGE_KWH,
        scheduleMode: DEFAULT_SCHEDULE_MODE,
        createdAt: now,
        updatedAt: now,
      },
    })
    return
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error
    }
  }

  const existing = await meters.where({ meterId }).get()
  const current = existing.data[0]

  if (!current || !current._id) {
    throw new Error(`创建电表 ${meterId} 时检测到重复键，但未能读取已有记录`)
  }

  await meters.doc(current._id).update({
    data: buildExistingMeterData(current, type, now),
  })
}

export async function main(event: SaveConfigInput): Promise<SaveConfigResult> {
  const { OPENID } = getCloudContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  const input = validateInput(event)
  const db = getDatabase()
  const now = db.serverDate()
  const userConfigs = db.collection<UserConfig & StoredDocument>(COLLECTIONS.userConfigs)
  const existing = await userConfigs.where({ openid: OPENID }).get()
  const current = existing.data[0]
  const config = {
    openid: OPENID,
    lightMeterId: input.lightMeterId,
    acMeterId: input.acMeterId,
    email: input.email,
    reminderEnabled: input.reminderEnabled,
  }

  if (current && current._id) {
    const remove = db.command.remove()
    await userConfigs.doc(current._id).update({
      data: {
        ...config,
        updatedAt: now,
        subscribeStatus: remove,
        thresholdKwh: remove,
        lastManualLightQueryAt: remove,
        manualLightQueryLockUntil: remove,
        lastManualAcQueryAt: remove,
        manualAcQueryLockUntil: remove,
      },
    })
  } else {
    await userConfigs.add({
      data: {
        ...config,
        createdAt: now,
        updatedAt: now,
      },
    })
  }

  await upsertMeter(db, input.lightMeterId, 'light')
  await upsertMeter(db, input.acMeterId, 'ac')

  return {
    ok: true,
    config,
  }
}
