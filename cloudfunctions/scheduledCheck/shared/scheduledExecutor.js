const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
  powerRecords: 'power_records',
  notificationRecords: 'notification_records',
  meterCheckJobs: 'meter_check_jobs',
}

const DEFAULT_POWER_BASE_URL = 'https://shsd.buaa.edu.cn/PubBuaa'
const XYL_AC_POWER_BASE_URL = 'https://xylktsd.buaa.edu.cn/PubBuaa'
const REQUEST_TIMEOUT_MS = 3000
const DEFAULT_CHECK_INTERVAL_MINUTES = 10
const MIN_CHECK_INTERVAL_MINUTES = 1
const DEFAULT_ESTIMATED_DAILY_USAGE_KWH = 5
const MIN_ESTIMATED_DAILY_USAGE_KWH = 0.5
const SAFETY_MARGIN_DAYS = 2
const NEAR_THRESHOLD_BAND_KWH = 5
const DEFAULT_REMINDER_THRESHOLD_KWH = 20
const RECHARGE_DELTA_KWH = 5
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MIN_ESTIMATE_SAMPLE_INTERVAL_DAYS = 1

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
    /閸︽澘娼?\s*(.*?)<\/p>/is,
    /<p[^>]*font-size:\s*20px;[^>]*>(.*?)<\/p>/is,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const value = decodeHtml(match[1])
        .replace(/\u54c8\u54c8/g, '')
        .replace(/鍝堝搱/g, '')
        .trim()
      if (value) {
        return value
      }
    }
  }

  return undefined
}

function shouldUseXueyuanRoadAcSite(meterId, type) {
  const normalizedMeterId = String(meterId || '').trim()

  return type === 'ac' && /^\d+$/.test(normalizedMeterId) && Number(normalizedMeterId) < 10000
}

function selectPowerBaseUrl(meterId, type) {
  return shouldUseXueyuanRoadAcSite(meterId, type)
    ? XYL_AC_POWER_BASE_URL
    : DEFAULT_POWER_BASE_URL
}

function fetchPowerPage(meterId, type) {
  const url = new URL(selectPowerBaseUrl(meterId, type))
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

function normalizeCheckIntervalMinutes(value) {
  const minutes = Number(value)

  if (!Number.isFinite(minutes) || minutes < MIN_CHECK_INTERVAL_MINUTES) {
    return DEFAULT_CHECK_INTERVAL_MINUTES
  }

  return Math.floor(minutes)
}

function normalizeEstimatedDailyUsageKwh(value) {
  const usage = Number(value)

  if (!Number.isFinite(usage) || usage < MIN_ESTIMATED_DAILY_USAGE_KWH) {
    return DEFAULT_ESTIMATED_DAILY_USAGE_KWH
  }

  return usage
}

function calculateScheduleState(input) {
  const now = input.now || new Date()
  const meter = input.meter || {}
  const record = input.record
  const previousRecord = input.previousRecord
  const thresholdKwh = DEFAULT_REMINDER_THRESHOLD_KWH
  const previousMode = meter.scheduleMode || 'normal'
  const previousEstimate = normalizeEstimatedDailyUsageKwh(meter.estimatedDailyUsageKwh)
  let estimatedDailyUsageKwh = previousEstimate
  let rechargeDetected = false
  let scheduleMode = previousMode === 'notified' ? 'notified' : 'normal'
  let nextCheckAt = new Date(now.getTime() + normalizeCheckIntervalMinutes(meter.checkIntervalMinutes) * 60 * 1000)
  let lastRechargeDetectedAt = meter.lastRechargeDetectedAt
  let lowPowerNotifiedAt = meter.lowPowerNotifiedAt

  if (!record.ok || record.remainingKwh === undefined) {
    return {
      estimatedDailyUsageKwh,
      scheduleMode,
      nextCheckAt,
      rechargeDetected,
      lastRechargeDetectedAt,
      lowPowerNotifiedAt,
      previousMode,
    }
  }

  const previousRemainingKwh = previousRecord && previousRecord.remainingKwh
  const previousQueriedAt = asDate(previousRecord && previousRecord.queriedAt)

  if (previousRemainingKwh !== undefined && record.remainingKwh >= previousRemainingKwh + RECHARGE_DELTA_KWH) {
    rechargeDetected = true
    lastRechargeDetectedAt = record.queriedAt
    lowPowerNotifiedAt = null
    scheduleMode = 'normal'
  }

  if (!rechargeDetected && previousRemainingKwh !== undefined && previousQueriedAt) {
    const elapsedDays = (record.queriedAt.getTime() - previousQueriedAt.getTime()) / ONE_DAY_MS
    const observedDailyUsage = (previousRemainingKwh - record.remainingKwh) / elapsedDays

    if (elapsedDays >= MIN_ESTIMATE_SAMPLE_INTERVAL_DAYS && observedDailyUsage > 0) {
      estimatedDailyUsageKwh = Math.max(
        MIN_ESTIMATED_DAILY_USAGE_KWH,
        previousEstimate * 0.8 + observedDailyUsage * 0.2,
      )
    }
  }

  const distanceToThreshold = record.remainingKwh - thresholdKwh

  if (distanceToThreshold <= 0) {
    scheduleMode = 'notified'
    nextCheckAt = new Date(now.getTime() + ONE_DAY_MS)
    lowPowerNotifiedAt = previousMode === 'notified' && !rechargeDetected && lowPowerNotifiedAt
      ? lowPowerNotifiedAt
      : record.queriedAt
  } else if (distanceToThreshold <= NEAR_THRESHOLD_BAND_KWH) {
    scheduleMode = 'near_threshold'
    nextCheckAt = new Date(now.getTime() + ONE_DAY_MS)
    lowPowerNotifiedAt = null
  } else {
    scheduleMode = 'normal'
    const daysUntilThreshold = distanceToThreshold / estimatedDailyUsageKwh
    const daysUntilNextCheck = Math.max(1, daysUntilThreshold - SAFETY_MARGIN_DAYS)
    nextCheckAt = new Date(now.getTime() + daysUntilNextCheck * ONE_DAY_MS)
    lowPowerNotifiedAt = null
  }

  return {
    estimatedDailyUsageKwh,
    scheduleMode,
    nextCheckAt,
    rechargeDetected,
    lastRechargeDetectedAt,
    lowPowerNotifiedAt,
    previousMode,
  }
}

async function getPreviousSuccessfulPowerRecord(db, meterId) {
  try {
    const result = await db.collection(COLLECTIONS.powerRecords)
      .where({
        meterId,
      })
      .orderBy('queriedAt', 'desc')
      .limit(50)
      .get()

    return result.data.find((record) => (
      record
      && record.source === 'scheduledCheck'
      && record.ok === true
      && record.remainingKwh !== undefined
    ))
  } catch (error) {
    console.warn('Failed to read previous power record', {
      meterId,
      error,
    })
    return undefined
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

async function queryMeter(meter, type) {
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
    const html = await fetchPowerPage(meterId, type)
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

async function updateMeter(db, meter, record, type, options) {
  const now = db.serverDate()
  const checkIntervalMinutes = normalizeCheckIntervalMinutes(meter && meter.checkIntervalMinutes)
  const schedule = calculateScheduleState({
    meter,
    record,
    previousRecord: options && options.previousRecord,
    now: record.queriedAt,
  })
  const data = {
    type,
    lastQueriedAt: record.queriedAt,
    nextCheckAt: schedule.nextCheckAt,
    checkIntervalMinutes,
    estimatedDailyUsageKwh: schedule.estimatedDailyUsageKwh,
    scheduleMode: schedule.scheduleMode,
    lastRechargeDetectedAt: schedule.lastRechargeDetectedAt || null,
    lowPowerNotifiedAt: schedule.lowPowerNotifiedAt || null,
    failCount: record.ok ? 0 : ((meter && meter.failCount) || 0) + 1,
    lastError: record.error || '',
    updatedAt: now,
  }

  if (record.remainingKwh !== undefined) {
    data.lastRemainingKwh = record.remainingKwh
  }

  if (meter && meter._id) {
    await db.collection(COLLECTIONS.meters).doc(meter._id).update({ data })
    return schedule
  }

  await db.collection(COLLECTIONS.meters).add({
    data: {
      meterId: record.meterId,
      createdAt: now,
      ...data,
    },
  })

  return schedule
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
    email: input.email,
    meterId: input.record.meterId,
    type: input.type,
    remainingKwh: input.record.remainingKwh,
    thresholdKwh: input.thresholdKwh,
    sentAt: db.serverDate(),
    status: input.result.status,
    channel: 'email',
    source: 'scheduledCheck',
  }

  if (input.result.error) {
    data.error = input.result.error
  }

  await db.collection(COLLECTIONS.notificationRecords).add({ data })
}

function shouldSendEmailNotification(config, record) {
  const email = normalizeEmail(config && config.email)

  if (!config || config.reminderEnabled !== true) {
    return false
  }

  if (!record.ok || record.remainingKwh === undefined) {
    return false
  }

  if (!email || !isValidEmail(email)) {
    return false
  }

  return record.remainingKwh <= DEFAULT_REMINDER_THRESHOLD_KWH
}

async function hasSentNotificationInCurrentLowPowerCycle(db, input) {
  const cycleStart = asDate(input.schedule && input.schedule.lowPowerNotifiedAt)
  const query = {
    openid: input.config.openid,
    meterId: input.record.meterId,
    type: input.type,
    channel: 'email',
    status: 'sent',
  }

  if (cycleStart) {
    query.sentAt = db.command.gte(cycleStart)
  }

  try {
    const result = await db.collection(COLLECTIONS.notificationRecords)
      .where(query)
      .limit(1)
      .get()

    return result.data.length > 0
  } catch (error) {
    console.warn('Failed to read notification history', {
      openid: input.config && input.config.openid,
      meterId: input.record && input.record.meterId,
      type: input.type,
      error,
    })
    return false
  }
}

async function sendEmailNotification(input) {
  try {
    const response = await cloud.callFunction({
      name: 'sendEmailNotification',
      data: {
        openid: input.config.openid,
        email: normalizeEmail(input.config.email),
        meterId: input.record.meterId,
        type: input.type,
        remainingKwh: input.record.remainingKwh,
        thresholdKwh: DEFAULT_REMINDER_THRESHOLD_KWH,
        queriedAt: input.record.queriedAt,
        address: input.record.address || '',
        source: 'scheduledCheck',
      },
    })
    const result = response && response.result

    return {
      status: result && result.status ? result.status : 'failed',
      error: result && result.error,
    }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function notifyUsersForMeter(db, record, type, configs, schedule) {
  let sentNotifications = 0
  let failedNotifications = 0
  let skippedNotifications = 0

  for (const config of configs) {
    if (!shouldSendEmailNotification(config, record, schedule)) {
      continue
    }

    if (await hasSentNotificationInCurrentLowPowerCycle(db, {
      config,
      type,
      record,
      schedule,
    })) {
      continue
    }

    try {
      const result = await sendEmailNotification({
        config,
        type,
        record,
      })

      await recordNotification(db, {
        openid: config.openid,
        email: normalizeEmail(config.email),
        type,
        record,
        thresholdKwh: DEFAULT_REMINDER_THRESHOLD_KWH,
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
  const record = await queryMeter(meter, type)
  const previousRecord = await getPreviousSuccessfulPowerRecord(db, record.meterId)
  const configs = await findBoundReminderConfigs(db, record.meterId, type)

  await db.collection(COLLECTIONS.powerRecords).add({
    data: {
      ...record,
      type,
      source: 'scheduledCheck',
    },
  })
  const schedule = await updateMeter(db, meter, record, type, {
    previousRecord,
  })

  if (!record.ok || record.remainingKwh === undefined) {
    return {
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
    }
  }

  return notifyUsersForMeter(db, record, type, configs, schedule)
}

async function getMeterForJob(db, job) {
  if (job.meterDocId) {
    const result = await db.collection(COLLECTIONS.meters).doc(job.meterDocId).get()
    return result.data
  }

  const result = await db.collection(COLLECTIONS.meters)
    .where({
      meterId: job.meterId,
      type: job.type,
    })
    .limit(1)
    .get()

  return result.data[0]
}

async function updateJobStatus(db, jobId, data) {
  await db.collection(COLLECTIONS.meterCheckJobs).doc(jobId).update({
    data: {
      ...data,
      updatedAt: db.serverDate(),
    },
  })
}

async function markJobExpired(db, job) {
  await updateJobStatus(db, job._id, {
    status: 'expired',
    finishedAt: db.serverDate(),
    error: 'Job expired before dispatch',
  })
}

async function claimJob(db, job) {
  const _ = db.command
  const now = new Date()
  const plannedAt = asDate(job.plannedAt)
  const deadlineAt = asDate(job.deadlineAt)

  if (plannedAt && plannedAt > now) {
    return {
      claimed: false,
      status: 'pending',
      reason: 'Job is not due yet',
    }
  }

  if (deadlineAt && deadlineAt < now) {
    await markJobExpired(db, job)
    return {
      claimed: false,
      status: 'expired',
      reason: 'Job expired before dispatch',
    }
  }

  const result = await db.collection(COLLECTIONS.meterCheckJobs)
    .where({
      _id: job._id,
      status: 'pending',
    })
    .update({
      data: {
        status: 'running',
        attempts: _.inc(1),
        startedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })

  const updated = result && result.stats && result.stats.updated

  return {
    claimed: updated > 0,
    status: updated > 0 ? 'running' : 'skipped',
    reason: updated > 0 ? '' : 'Job was already claimed',
  }
}

async function executePlannedJob(db, jobId) {
  if (!jobId) {
    return {
      checkedMeters: 0,
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
      status: 'failed',
      error: 'Missing jobId',
    }
  }

  let job

  try {
    const result = await db.collection(COLLECTIONS.meterCheckJobs).doc(jobId).get()
    job = result.data
  } catch (error) {
    return {
      checkedMeters: 0,
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (!job || job.status !== 'pending') {
    return {
      checkedMeters: 0,
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
      status: job && job.status ? job.status : 'missing',
    }
  }

  const claim = await claimJob(db, job)

  if (!claim.claimed) {
    return {
      checkedMeters: 0,
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
      status: claim.status,
      error: claim.reason,
    }
  }

  try {
    const meter = await getMeterForJob(db, job)

    if (!meter) {
      throw new Error('Meter not found for planned job')
    }

    const meterResult = await processMeter(db, meter)

    await updateJobStatus(db, job._id, {
      status: 'done',
      finishedAt: db.serverDate(),
      error: '',
    })

    return {
      checkedMeters: 1,
      sentNotifications: meterResult.sentNotifications,
      failedNotifications: meterResult.failedNotifications,
      skippedNotifications: meterResult.skippedNotifications,
      status: 'done',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    await updateJobStatus(db, job._id, {
      status: 'failed',
      finishedAt: db.serverDate(),
      error: message,
    })

    return {
      checkedMeters: 0,
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
      status: 'failed',
      error: message,
    }
  }
}

module.exports = {
  asDate,
  executePlannedJob,
}
