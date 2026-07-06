import { COLLECTIONS, getCloudContext, getDatabase } from '../shared/db'
import type { Meter, SaveConfigInput, SubscribeStatus, UserConfig } from '../shared/types'

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
  'lightMeterId' | 'acMeterId' | 'email' | 'thresholdKwh' | 'reminderEnabled'
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
  const thresholdKwh = Number(input.thresholdKwh)

  if (!lightMeterId) {
    throw new Error('请填写宿舍照明电表号')
  }

  if (!acMeterId) {
    throw new Error('请填写宿舍空调电表号')
  }

  if (lightMeterId === acMeterId) {
    throw new Error('照明电表号和空调电表号不能相同')
  }

  if (!Number.isFinite(thresholdKwh) || thresholdKwh <= 0) {
    throw new Error('提醒阈值必须大于 0')
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
    thresholdKwh,
    reminderEnabled: true,
  }
}

function normalizeSubscribeStatus(value: SaveConfigInput['notificationSubscribeStatus']): SubscribeStatus | undefined {
  return value === 'accepted' || value === 'rejected' || value === 'unknown'
    ? value
    : undefined
}

async function upsertMeter(
  meterId: string,
  type: Meter['type'],
): Promise<void> {
  const db = getDatabase()
  const now = db.serverDate()
  const meters = db.collection<Meter & StoredDocument>(COLLECTIONS.meters)
  const existing = await meters.where({ meterId }).get()
  const current = existing.data[0]
  const data: Record<string, unknown> = {
    type,
    checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
    estimatedDailyUsageKwh: Number.isFinite(Number(current?.estimatedDailyUsageKwh))
      ? Number(current?.estimatedDailyUsageKwh)
      : DEFAULT_ESTIMATED_DAILY_USAGE_KWH,
    scheduleMode: current?.scheduleMode || DEFAULT_SCHEDULE_MODE,
    updatedAt: now,
  }

  if (current?._id) {
    await meters.doc(current._id).update({ data })
    return
  }

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
  const subscribeStatus: SubscribeStatus = normalizeSubscribeStatus(event.notificationSubscribeStatus)
    || current?.subscribeStatus
    || 'unknown'
  const config = {
    openid: OPENID,
    lightMeterId: input.lightMeterId,
    acMeterId: input.acMeterId,
    email: input.email,
    thresholdKwh: input.thresholdKwh,
    reminderEnabled: input.reminderEnabled,
    subscribeStatus,
  }

  if (current?._id) {
    await userConfigs.doc(current._id).update({
      data: {
        ...config,
        updatedAt: now,
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

  await upsertMeter(input.lightMeterId, 'light')
  await upsertMeter(input.acMeterId, 'ac')

  return {
    ok: true,
    config,
  }
}
