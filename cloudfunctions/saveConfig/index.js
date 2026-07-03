const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
}

const DEFAULT_CHECK_INTERVAL_MINUTES = 10

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

function normalizeSubscribeStatus(value) {
  return value === 'accepted' || value === 'rejected' || value === 'unknown'
    ? value
    : undefined
}

async function upsertMeter(db, meterId, type) {
  const now = db.serverDate()
  const meters = db.collection(COLLECTIONS.meters)
  const existing = await meters.where({ meterId }).get()
  const current = existing.data[0]
  const data = {
    type,
    checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
    updatedAt: now,
  }

  if (current && current._id) {
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
      createdAt: now,
      updatedAt: now,
    },
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
