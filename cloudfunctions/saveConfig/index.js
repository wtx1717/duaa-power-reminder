const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
}

const DEFAULT_CHECK_INTERVAL_MINUTES = 10
const DEFAULT_ESTIMATED_DAILY_USAGE_KWH = 5
const DEFAULT_SCHEDULE_MODE = 'normal'
const DEFAULT_REMINDER_THRESHOLD_KWH = 20

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function normalizeMeterId(value) {
  return String(value || '').trim()
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function validateInput(input) {
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
    thresholdKwh: DEFAULT_REMINDER_THRESHOLD_KWH,
    reminderEnabled: true,
  }
}

function normalizeSubscribeStatus(value) {
  return value === 'accepted' || value === 'rejected' || value === 'unknown'
    ? value
    : undefined
}

function getErrorDetails(error) {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const fields = [
      error.code,
      error.errCode,
      error.errorCode,
      error.message,
      error.errMsg,
    ].filter((item) => typeof item === 'string' || typeof item === 'number')

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

function isDuplicateKeyError(error) {
  const details = getErrorDetails(error)
  return /E11000|DUPLICATE[_\s-]*KEY|duplicate\s+key|duplicate\s+key\s+error|duplicate.*(?:index|unique)|unique.*(?:index|constraint|key)|唯一.*(?:索引|键)|(?:索引|键).*唯一/i.test(details)
}

function buildExistingMeterData(current, type, updatedAt) {
  return {
    type,
    checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
    estimatedDailyUsageKwh: current && Number.isFinite(Number(current.estimatedDailyUsageKwh))
      ? Number(current.estimatedDailyUsageKwh)
      : DEFAULT_ESTIMATED_DAILY_USAGE_KWH,
    scheduleMode: current && current.scheduleMode ? current.scheduleMode : DEFAULT_SCHEDULE_MODE,
    updatedAt,
  }
}

async function upsertMeter(db, meterId, type) {
  const now = db.serverDate()
  const meters = db.collection(COLLECTIONS.meters)
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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  const input = validateInput(event)
  const db = cloud.database()
  const now = db.serverDate()
  const userConfigs = db.collection(COLLECTIONS.userConfigs)
  const existing = await userConfigs.where({ openid: OPENID }).get()
  const current = existing.data[0]
  const subscribeStatus = normalizeSubscribeStatus(event.notificationSubscribeStatus)
    || (current && current.subscribeStatus)
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

  if (current && current._id) {
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

  await upsertMeter(db, input.lightMeterId, 'light')
  await upsertMeter(db, input.acMeterId, 'ac')

  return {
    ok: true,
    config,
  }
}

exports.isDuplicateKeyError = isDuplicateKeyError
exports.upsertMeter = upsertMeter
