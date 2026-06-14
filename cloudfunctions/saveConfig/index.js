const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function normalizeMeterId(value) {
  return String(value || '').trim()
}

function parseNextCheckAt(value) {
  if (!value) {
    return undefined
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new Error('定时查询时间不正确')
  }

  return date
}

function parseCheckIntervalMinutes(value) {
  const minutes = value === undefined || value === null || value === ''
    ? 24 * 60
    : Number(value)

  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new Error('查询间隔不能小于 1 分钟')
  }

  return Math.floor(minutes)
}

function validateInput(input) {
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

function normalizeSubscribeStatus(value) {
  return value === 'accepted' || value === 'rejected' || value === 'unknown'
    ? value
    : undefined
}

async function upsertMeter(db, meterId, type, nextCheckAt, checkIntervalMinutes) {
  const now = db.serverDate()
  const meters = db.collection(COLLECTIONS.meters)
  const existing = await meters.where({ meterId }).get()
  const current = existing.data[0]
  const data = {
    type,
    checkIntervalMinutes,
    updatedAt: now,
  }

  if (nextCheckAt) {
    data.nextCheckAt = nextCheckAt
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
      nextCheckAt: nextCheckAt || new Date(),
      checkIntervalMinutes,
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

  await upsertMeter(db, input.lightMeterId, 'light', input.nextCheckAt, input.checkIntervalMinutes)
  await upsertMeter(db, input.acMeterId, 'ac', input.nextCheckAt, input.checkIntervalMinutes)

  return {
    ok: true,
    config,
  }
}
