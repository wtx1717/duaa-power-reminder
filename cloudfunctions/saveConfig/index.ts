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

interface ValidatedSaveConfigInput extends SaveConfigInput {
  nextCheckAt?: Date
  checkIntervalMinutes: number
}

function normalizeMeterId(value: string): string {
  return String(value || '').trim()
}

function parseNextCheckAt(value: SaveConfigInput['nextCheckAt']): Date | undefined {
  if (!value) {
    return undefined
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new Error('定时查询时间不正确')
  }

  return date
}

function parseCheckIntervalMinutes(value: SaveConfigInput['checkIntervalMinutes']): number {
  const minutes = value === undefined || value === null || value === ''
    ? 24 * 60
    : Number(value)

  if (!Number.isFinite(minutes) || minutes < 5) {
    throw new Error('查询间隔不能小于 5 分钟')
  }

  return Math.floor(minutes)
}

function validateInput(input: SaveConfigInput): ValidatedSaveConfigInput {
  const lightMeterId = normalizeMeterId(input.lightMeterId)
  const acMeterId = normalizeMeterId(input.acMeterId)
  const thresholdKwh = Number(input.thresholdKwh)
  const nextCheckAt = parseNextCheckAt(input.nextCheckAt)
  const checkIntervalMinutes = parseCheckIntervalMinutes(input.checkIntervalMinutes)

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

  return {
    lightMeterId,
    acMeterId,
    thresholdKwh,
    reminderEnabled: Boolean(input.reminderEnabled),
    nextCheckAt,
    checkIntervalMinutes,
  }
}

async function upsertMeter(
  meterId: string,
  type: Meter['type'],
  nextCheckAt?: Date,
  checkIntervalMinutes = 24 * 60,
): Promise<void> {
  const db = getDatabase()
  const now = db.serverDate()
  const meters = db.collection<Meter & StoredDocument>(COLLECTIONS.meters)
  const existing = await meters.where({ meterId }).get()
  const current = existing.data[0]
  const data: Record<string, unknown> = {
    type,
    checkIntervalMinutes,
    updatedAt: now,
  }

  if (nextCheckAt) {
    data.nextCheckAt = nextCheckAt
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
      nextCheckAt: nextCheckAt || new Date(),
      checkIntervalMinutes,
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
  const subscribeStatus: SubscribeStatus = current?.subscribeStatus || 'unknown'
  const config = {
    openid: OPENID,
    lightMeterId: input.lightMeterId,
    acMeterId: input.acMeterId,
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

  await upsertMeter(input.lightMeterId, 'light', input.nextCheckAt, input.checkIntervalMinutes)
  await upsertMeter(input.acMeterId, 'ac', input.nextCheckAt, input.checkIntervalMinutes)

  return {
    ok: true,
    config,
  }
}
