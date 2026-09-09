// saveConfig 的 TypeScript 业务实现。
// 它负责校验用户配置、创建或更新电表，并清理被替换且不再共享的旧电表。
import { COLLECTIONS, getCloudContext, getDatabase } from '../shared/db'
import type { DatabaseAdapter } from '../shared/db'
import { cleanMeter } from './shared/meterCleanup'
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

type CleanupTarget = {
  meterId: string
  type: Meter['type']
}

const DEFAULT_CHECK_INTERVAL_MINUTES = 10
const DEFAULT_ESTIMATED_DAILY_USAGE_KWH = 5
const DEFAULT_SCHEDULE_MODE = 'normal'

function normalizeMeterId(value: string): string {
  // 统一去掉用户输入两端的空白，避免同一个电表被保存成多个字符串。
  return String(value || '').trim()
}

function normalizeEmail(value: string): string {
  // 邮箱不区分大小写，统一转小写后再保存和查询。
  return String(value || '').trim().toLowerCase()
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function validateInput(input: SaveConfigInput): ValidatedSaveConfigInput {
  // 前端会校验一次，但云函数必须再次校验，因为客户端输入不能被信任。
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

function collectCleanupTargets(
  current: (UserConfig & StoredDocument) | undefined,
  next: ValidatedSaveConfigInput,
): CleanupTarget[] {
  // 只清理旧配置中已经被新配置替换、且没有继续使用的电表。
  if (!current) {
    return []
  }

  const nextMeterIds = new Set([
    normalizeMeterId(next.lightMeterId),
    normalizeMeterId(next.acMeterId),
  ])
  const targets: CleanupTarget[] = []
  const seen = new Set<string>()

  for (const type of ['light', 'ac'] as const) {
    const field = type === 'ac' ? 'acMeterId' : 'lightMeterId'
    const meterId = normalizeMeterId(current[field])

    if (!meterId || nextMeterIds.has(meterId) || seen.has(meterId)) {
      continue
    }

    seen.add(meterId)
    targets.push({ meterId, type })
  }

  return targets
}

function getErrorDetails(error: unknown): string {
  // 将不同 SDK 错误形态转换成可记录、可展示的文本。
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
  // 并发保存时两个请求可能同时 add；重复键表示另一请求已经创建了电表。
  const details = getErrorDetails(error)
  return /E11000|DUPLICATE[_\s-]*KEY|duplicate\s+key|duplicate\s+key\s+error|duplicate.*(?:index|unique)|unique.*(?:index|constraint|key)|唯一.*(?:索引|键)|(?:索引|键).*唯一/i.test(details)
}

function buildExistingMeterData(
  current: (Meter & StoredDocument) | undefined,
  type: Meter['type'],
  updatedAt: Date,
): Record<string, unknown> {
  // 更新已有电表时保留历史日耗和调度模式，只刷新绑定类型和更新时间。
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
  // 先尝试创建；遇到唯一索引冲突后读取已有记录并更新，保证并发绑定最终收敛。
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
  // 保存顺序：识别用户 -> 校验输入 -> 写用户配置 -> upsert 两块电表 -> 清理旧电表。
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
  const cleanupTargets = collectCleanupTargets(current, input)
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

  for (const target of cleanupTargets) {
    await cleanMeter(db, target, OPENID)
  }

  return {
    ok: true,
    config,
  }
}
