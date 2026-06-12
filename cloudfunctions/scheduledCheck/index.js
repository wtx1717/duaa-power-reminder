const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
  powerRecords: 'power_records',
  notificationRecords: 'notification_records',
  jobLocks: 'job_locks',
}

const POWER_BASE_URL = 'https://shsd.buaa.edu.cn/PubBuaa'
const REQUEST_TIMEOUT_MS = 15000
const LOW_POWER_TEMPLATE_ID = '6PcRlFLgfDTAFnepb7jfsj1K-w7jG6oZsqbyXZMgdp4'
const MAX_METERS_PER_RUN = 20
const DEFAULT_CHECK_INTERVAL_MINUTES = 24 * 60
const MIN_CHECK_INTERVAL_MINUTES = 5
const LOCK_NAME = 'scheduledCheck'
const LOCK_TTL_MS = 10 * 60 * 1000

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function stripTags(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function decodeHtml(value) {
  return stripTags(value)
    .replace(/&#x([0-9a-f]+);/gi, (_entity, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_entity, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function parseNumber(text) {
  const cleaned = decodeHtml(text).replace(/,/g, '')
  const match = cleaned.match(/-?\d+(?:\.\d+)?/)

  if (!match) {
    return undefined
  }

  const value = Number(match[0])
  return Number.isFinite(value) ? value : undefined
}

function parseRemainingKwh(html) {
  const patterns = [
    /<use[^>]+xlink:href=["']#widget-headRemain["'][^>]*>.*?<tspan[^>]*>(.*?)<\/tspan>/is,
    /<svg[^>]+id=["']canvas1["'][^>]*>.*?<tspan[^>]*>(.*?)<\/tspan>/is,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const value = parseNumber(match[1])
      if (value !== undefined) {
        return value
      }
    }
  }

  return undefined
}

function parseCutoffTime(html) {
  const matches = html.matchAll(/\[([^\]]+)\]/g)
  const dateTimePattern = /\d{4}[-/\u5e74]\d{1,2}[-/\u6708]\d{1,2}|\d{1,2}:\d{2}/

  for (const match of matches) {
    const value = decodeHtml(match[1])

    if (dateTimePattern.test(value)) {
      return value
    }
  }

  return undefined
}

function parseAddress(html) {
  const patterns = [
    /\u5730\u5740:\s*(.*?)<\/p>/is,
    /鍦板潃:\s*(.*?)<\/p>/is,
    /<p[^>]*font-size:\s*20px;[^>]*>(.*?)<\/p>/is,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const value = decodeHtml(match[1]).replace('\u54c8\u54c8', '').replace('鍝堝搱', '').trim()
      if (value) {
        return value
      }
    }
  }

  return undefined
}

function fetchPowerPage(meterId) {
  const url = new URL(POWER_BASE_URL)
  url.searchParams.set('id', meterId)

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 BUAA power mini program',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (response) => {
      const chunks = []

      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const html = buffer.toString('utf8')

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }

        resolve(html)
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error('Request power page timeout'))
    })
    request.on('error', reject)
  })
}

function asDate(value) {
  if (!value) {
    return undefined
  }

  if (value instanceof Date) {
    return value
  }

  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate()
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function limitThing(value) {
  return String(value || '').slice(0, 20)
}

function getMeterTypeLabel(type) {
  return type === 'ac'
    ? '\u7a7a\u8c03\u7535\u8868'
    : '\u7167\u660e\u7535\u8868'
}

function normalizeCheckIntervalMinutes(value) {
  const minutes = Number(value)

  if (!Number.isFinite(minutes) || minutes < MIN_CHECK_INTERVAL_MINUTES) {
    return DEFAULT_CHECK_INTERVAL_MINUTES
  }

  return Math.floor(minutes)
}

function isCollectionNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist|job_locks/i.test(message)
}

async function acquireJobLock(db) {
  const now = new Date()
  const lockedUntil = new Date(now.getTime() + LOCK_TTL_MS)
  const owner = `${LOCK_NAME}-${now.getTime()}-${Math.random().toString(16).slice(2)}`
  const locks = db.collection(COLLECTIONS.jobLocks)

  let existing
  try {
    existing = await locks.where({ name: LOCK_NAME }).get()
  } catch (error) {
    if (isCollectionNotFoundError(error)) {
      try {
        if (typeof db.createCollection === 'function') {
          await db.createCollection(COLLECTIONS.jobLocks)
        }

        const addResult = await locks.add({
          data: {
            name: LOCK_NAME,
            lockedUntil,
            owner,
            updatedAt: db.serverDate(),
          },
        })

        return {
          acquired: true,
          lockId: addResult._id || addResult.id,
          owner,
        }
      } catch (createError) {
        console.warn('job_locks collection is unavailable, scheduledCheck will run without lock', createError)
        return {
          acquired: true,
          lockDisabled: true,
          owner,
        }
      }
    }

    throw error
  }

  const current = existing.data[0]
  const currentLockedUntil = asDate(current && current.lockedUntil)

  if (current && currentLockedUntil && currentLockedUntil > now) {
    return {
      acquired: false,
      lockedUntil: currentLockedUntil,
    }
  }

  if (current && current._id) {
    await locks.doc(current._id).update({
      data: {
        lockedUntil,
        owner,
        updatedAt: db.serverDate(),
      },
    })

    return {
      acquired: true,
      lockId: current._id,
      owner,
    }
  }

  const addResult = await locks.add({
    data: {
      name: LOCK_NAME,
      lockedUntil,
      owner,
      updatedAt: db.serverDate(),
    },
  })

  return {
    acquired: true,
    lockId: addResult._id || addResult.id,
    owner,
  }
}

async function releaseJobLock(db, lock) {
  if (!lock || lock.lockDisabled || !lock.lockId) {
    return
  }

  try {
    await db.collection(COLLECTIONS.jobLocks).doc(lock.lockId).update({
      data: {
        lockedUntil: new Date(0),
        owner: lock.owner || '',
        updatedAt: db.serverDate(),
      },
    })
  } catch (error) {
    console.error('Failed to release scheduledCheck lock', error)
  }
}

async function getDueMeters(db) {
  const _ = db.command
  const now = new Date()

  return db.collection(COLLECTIONS.meters)
    .where({
      nextCheckAt: _.lte(now),
    })
    .orderBy('nextCheckAt', 'asc')
    .limit(MAX_METERS_PER_RUN)
    .get()
}

async function queryMeter(meter) {
  const meterId = String(meter.meterId || '').trim()
  const queriedAt = new Date()

  if (!meterId) {
    return {
      meterId,
      ok: false,
      error: 'Missing meterId',
      queriedAt,
    }
  }

  try {
    const html = await fetchPowerPage(meterId)
    const remainingKwh = parseRemainingKwh(html)

    if (remainingKwh === undefined) {
      return {
        meterId,
        ok: false,
        error: 'Unable to parse remaining kWh',
        queriedAt,
      }
    }

    return {
      meterId,
      remainingKwh,
      cutoffTime: parseCutoffTime(html),
      address: parseAddress(html),
      ok: true,
      queriedAt,
    }
  } catch (error) {
    return {
      meterId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      queriedAt,
    }
  }
}

async function updateMeter(db, meter, record, type) {
  const now = db.serverDate()
  const checkIntervalMinutes = normalizeCheckIntervalMinutes(meter && meter.checkIntervalMinutes)
  const data = {
    type,
    lastQueriedAt: record.queriedAt,
    nextCheckAt: new Date(Date.now() + checkIntervalMinutes * 60 * 1000),
    checkIntervalMinutes,
    failCount: record.ok ? 0 : ((meter && meter.failCount) || 0) + 1,
    lastError: record.error || '',
    updatedAt: now,
  }

  if (record.remainingKwh !== undefined) {
    data.lastRemainingKwh = record.remainingKwh
  }

  if (meter && meter._id) {
    await db.collection(COLLECTIONS.meters).doc(meter._id).update({ data })
    return
  }

  await db.collection(COLLECTIONS.meters).add({
    data: {
      meterId: record.meterId,
      createdAt: now,
      ...data,
    },
  })
}

async function findBoundReminderConfigs(db, meterId, type) {
  const field = type === 'ac' ? 'acMeterId' : 'lightMeterId'
  const result = await db.collection(COLLECTIONS.userConfigs).where({
    [field]: meterId,
    reminderEnabled: true,
  }).get()

  return result.data
}

async function recordNotification(db, input) {
  const data = {
    openid: input.openid,
    meterId: input.record.meterId,
    type: input.type,
    remainingKwh: input.record.remainingKwh,
    thresholdKwh: input.thresholdKwh,
    sentAt: db.serverDate(),
    status: input.result.status,
    source: 'scheduledCheck',
  }

  if (input.result.error) {
    data.error = input.result.error
  }

  await db.collection(COLLECTIONS.notificationRecords).add({ data })
}

async function sendPowerQueryNotification(input) {
  if (!input.openid) {
    return {
      status: 'skipped',
      error: 'Missing openid',
    }
  }

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: input.openid,
      templateId: LOW_POWER_TEMPLATE_ID,
      page: 'pages/index/index',
      data: {
        character_string1: {
          value: String(input.record.remainingKwh),
        },
        thing2: {
          value: limitThing(input.record.address || '\u672a\u89e3\u6790\u5230\u516c\u5bd3\u5730\u5740'),
        },
        thing3: {
          value: limitThing(getMeterTypeLabel(input.type)),
        },
        time4: {
          value: formatDateTime(input.record.queriedAt),
        },
      },
    })

    return {
      status: 'sent',
    }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function notifyUsersForLightMeter(db, record, configs) {
  let sentNotifications = 0
  let failedNotifications = 0
  let skippedNotifications = 0

  for (const config of configs) {
    try {
      const result = await sendPowerQueryNotification({
        openid: config.openid,
        type: 'light',
        record,
      })

      await recordNotification(db, {
        openid: config.openid,
        type: 'light',
        record,
        thresholdKwh: config.thresholdKwh,
        result,
      })

      if (result.status === 'sent') {
        sentNotifications += 1
      } else if (result.status === 'failed') {
        failedNotifications += 1
      } else {
        skippedNotifications += 1
      }
    } catch (error) {
      failedNotifications += 1
      console.error('Failed to process scheduled notification', {
        meterId: record.meterId,
        openid: config.openid,
        error,
      })
    }
  }

  return {
    sentNotifications,
    failedNotifications,
    skippedNotifications,
  }
}

function getMeterType(meter) {
  return meter && meter.type === 'ac' ? 'ac' : 'light'
}

async function processMeter(db, meter) {
  const type = getMeterType(meter)
  const record = await queryMeter(meter)

  await db.collection(COLLECTIONS.powerRecords).add({
    data: {
      ...record,
      type,
      source: 'scheduledCheck',
    },
  })
  await updateMeter(db, meter, record, type)

  if (type !== 'light' || !record.ok || record.remainingKwh === undefined) {
    return {
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
    }
  }

  const configs = await findBoundReminderConfigs(db, record.meterId, type)
  return notifyUsersForLightMeter(db, record, configs)
}

exports.main = async () => {
  const db = cloud.database()
  const lock = await acquireJobLock(db)

  if (!lock.acquired) {
    return {
      ok: true,
      locked: true,
      checkedMeters: 0,
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
      errors: [],
    }
  }

  const result = {
    ok: true,
    locked: false,
    lockDisabled: Boolean(lock.lockDisabled),
    checkedMeters: 0,
    sentNotifications: 0,
    failedNotifications: 0,
    skippedNotifications: 0,
    errors: [],
  }

  try {
    const dueMeters = await getDueMeters(db)

    for (const meter of dueMeters.data) {
      try {
        const meterResult = await processMeter(db, meter)
        result.checkedMeters += 1
        result.sentNotifications += meterResult.sentNotifications
        result.failedNotifications += meterResult.failedNotifications
        result.skippedNotifications += meterResult.skippedNotifications
      } catch (error) {
        result.errors.push({
          meterId: meter && meter.meterId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    await releaseJobLock(db, lock)
  }

  return result
}
