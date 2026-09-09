// saveConfig 云函数：校验配置、保存用户绑定，并处理旧电表清理。
const cloud = require('wx-server-sdk')
const { cleanMeter } = require('./shared/meterCleanup')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
}

const DEFAULT_CHECK_INTERVAL_MINUTES = 10
const DEFAULT_ESTIMATED_DAILY_USAGE_KWH = 5
const DEFAULT_SCHEDULE_MODE = 'normal'

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function normalizeMeterId(value) {
  // 去除输入两端空白，避免同一电表出现多个字符串表示。
  return String(value || '').trim()
}

function normalizeEmail(value) {
  // 邮箱统一转小写，保证保存、查询和通知去重使用同一形式。
  return String(value || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function validateInput(input) {
  // 服务端必须重复校验客户端输入，因为客户端传来的数据不能直接信任。
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

function collectCleanupTargets(current, next) {
  // 找出旧配置里不再被新配置使用的电表，后面交给共享清理逻辑处理。
  if (!current) {
    return []
  }

  const nextMeterIds = new Set([
    normalizeMeterId(next.lightMeterId),
    normalizeMeterId(next.acMeterId),
  ])
  const targets = []
  const seen = new Set()

  for (const type of ['light', 'ac']) {
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
  // 并发保存可能同时创建同一电表；重复键不是致命错误，而是读取已有记录并更新的信号。
  const details = getErrorDetails(error)
  return /E11000|DUPLICATE[_\s-]*KEY|duplicate\s+key|duplicate\s+key\s+error|duplicate.*(?:index|unique)|unique.*(?:index|constraint|key)|唯一.*(?:索引|键)|(?:索引|键).*唯一/i.test(details)
}

function buildExistingMeterData(current, type, updatedAt) {
  // 更新已有电表时保留日耗估算和调度模式，只刷新类型与更新时间。
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
  // 先 add 再处理重复键，形成“创建或更新”的幂等操作。
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
  // 主流程：识别用户 -> 校验 -> 保存配置 -> upsert 电表 -> 清理被替换的旧电表。
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

exports.isDuplicateKeyError = isDuplicateKeyError
exports.upsertMeter = upsertMeter
