// 定时巡检执行器。
// 它负责请求上游页面、解析结果、更新电表状态、估算日耗并触发低电量通知。
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
const SAFETY_MARGIN_DAYS = 2
const NEAR_THRESHOLD_BAND_KWH = 5
const DEFAULT_REMINDER_THRESHOLD_KWH = 20
const RECHARGE_DELTA_KWH = 5
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MIN_ESTIMATE_SAMPLE_INTERVAL_DAYS = 4
const MIN_OBSERVED_DAILY_USAGE_KWH = 1

function stripTags(value) {
  // 解析网页前先去掉标签；这里保留纯文本，不使用完整 DOM 解析器。
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function decodeHtml(value) {
  // 处理学校页面中的 HTML/XML 实体和数字实体。
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
  // 从一段文本中提取第一个数字，电量可能是整数或小数。
  const cleaned = decodeHtml(text).replace(/,/g, '')
  const match = cleaned.match(/-?\d+(?:\.\d+)?/)

  if (!match) {
    return undefined
  }

  const value = Number(match[0])
  return Number.isFinite(value) ? value : undefined
}

function parseRemainingKwh(html) {
  // 兼容上游页面的两种已知 SVG 结构，返回剩余电量 kWh。
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
  // 从方括号内容中寻找日期或时刻，作为页面显示的截止时间。
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
  // 地址字段在不同页面版本中结构不同，因此按多个正则依次尝试。
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
  // 学院路空调电表使用专用站点；其他电表走主站点。
  const normalizedMeterId = String(meterId || '').trim()

  return type === 'ac' && /^\d+$/.test(normalizedMeterId) && Number(normalizedMeterId) < 10000
}

function selectPowerBaseUrl(meterId, type) {
  return shouldUseXueyuanRoadAcSite(meterId, type)
    ? XYL_AC_POWER_BASE_URL
    : DEFAULT_POWER_BASE_URL
}

function fetchPowerPage(meterId, type) {
  // 发起 HTTPS 请求并返回完整 HTML；超时或 HTTP 错误会进入 catch。
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
  // 统一处理 Date、云开发日期对象和日期字符串。
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
  // 检查间隔至少为 1 分钟；非法或旧数据使用默认 10 分钟。
  const minutes = Number(value)

  if (!Number.isFinite(minutes) || minutes < MIN_CHECK_INTERVAL_MINUTES) {
    return DEFAULT_CHECK_INTERVAL_MINUTES
  }

  return Math.floor(minutes)
}

function normalizeEstimatedDailyUsageKwh(value) {
  // 日耗估算必须是正数，否则使用默认值 5 kWh/天。
  const usage = Number(value)

  if (!Number.isFinite(usage) || usage <= 0) {
    return DEFAULT_ESTIMATED_DAILY_USAGE_KWH
  }

  return usage
}

function isSuccessfulScheduledPowerRecord(record) {
  return Boolean(
    record
    && record.source === 'scheduledCheck'
    && record.ok === true
    && Number.isFinite(Number(record.remainingKwh))
    && asDate(record.queriedAt),
  )
}

function findEstimateBaseRecord(records, currentRecord) {
  // 在历史定时成功记录中寻找估算基准，并避开充值造成的电量跳升。
  const currentQueriedAt = asDate(currentRecord && currentRecord.queriedAt)

  if (
    !currentQueriedAt
    || !Number.isFinite(Number(currentRecord && currentRecord.remainingKwh))
  ) {
    return undefined
  }

  const history = (Array.isArray(records) ? records : [])
    .filter((record) => isSuccessfulScheduledPowerRecord(record))
    .filter((record) => asDate(record.queriedAt) < currentQueriedAt)
    .sort((left, right) => asDate(right.queriedAt).getTime() - asDate(left.queriedAt).getTime())

  let newerRecord = currentRecord

  for (const olderRecord of history) {
    const olderQueriedAt = asDate(olderRecord.queriedAt)
    const newerQueriedAt = asDate(newerRecord.queriedAt)

    if (!olderQueriedAt || !newerQueriedAt || olderQueriedAt >= newerQueriedAt) {
      continue
    }

    // 电量明显上升代表充值，不能把这段时间当成正常消耗来计算日耗。
    if (Number(newerRecord.remainingKwh) >= Number(olderRecord.remainingKwh) + RECHARGE_DELTA_KWH) {
      const elapsedDays = (currentQueriedAt.getTime() - newerQueriedAt.getTime()) / ONE_DAY_MS
      return elapsedDays >= MIN_ESTIMATE_SAMPLE_INTERVAL_DAYS ? newerRecord : undefined
    }

    const elapsedDays = (currentQueriedAt.getTime() - olderQueriedAt.getTime()) / ONE_DAY_MS

    if (elapsedDays >= MIN_ESTIMATE_SAMPLE_INTERVAL_DAYS) {
      return olderRecord
    }

    newerRecord = olderRecord
  }

  return undefined
}

function calculateScheduleState(input) {
  // 根据本次结果计算：是否充值、日耗估算、调度模式、下次检查时间和通知周期。
  const now = input.now || new Date()
  const meter = input.meter || {}
  const record = input.record
  const previousRecord = input.previousRecord
  const estimateBaseRecord = input.estimateBaseRecord
  const thresholdKwh = DEFAULT_REMINDER_THRESHOLD_KWH
  const previousMode = meter.scheduleMode || 'normal'
  const previousEstimate = normalizeEstimatedDailyUsageKwh(meter.estimatedDailyUsageKwh)
  let estimatedDailyUsageKwh = previousEstimate
  let rechargeDetected = false
  let scheduleMode = ['normal', 'near_threshold', 'notified'].includes(previousMode)
    ? previousMode
    : 'normal'
  let nextCheckAt = new Date(now.getTime() + normalizeCheckIntervalMinutes(meter.checkIntervalMinutes) * 60 * 1000)
  let lastRechargeDetectedAt = meter.lastRechargeDetectedAt
  let lowPowerNotifiedAt = meter.lowPowerNotifiedAt

  // 查询失败时保留旧估算，只按固定检查间隔安排下一次重试。
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

  // 本次电量比上次高出至少 5 kWh，认为用户充值并重置低电量通知周期。
  if (previousRemainingKwh !== undefined && record.remainingKwh >= previousRemainingKwh + RECHARGE_DELTA_KWH) {
    rechargeDetected = true
    lastRechargeDetectedAt = record.queriedAt
    lowPowerNotifiedAt = null
    scheduleMode = 'normal'
  }

  const estimateBaseRemainingKwh = estimateBaseRecord && estimateBaseRecord.remainingKwh
  const estimateBaseQueriedAt = asDate(estimateBaseRecord && estimateBaseRecord.queriedAt)

  // 只有跨过至少 4 天且观察到的日耗不低于 1 kWh，才更新估算，避免短期噪声污染。
  if (!rechargeDetected && estimateBaseRemainingKwh !== undefined && estimateBaseQueriedAt) {
    const elapsedDays = (record.queriedAt.getTime() - estimateBaseQueriedAt.getTime()) / ONE_DAY_MS
    const observedDailyUsage = (estimateBaseRemainingKwh - record.remainingKwh) / elapsedDays

    if (
      elapsedDays >= MIN_ESTIMATE_SAMPLE_INTERVAL_DAYS
      && observedDailyUsage >= MIN_OBSERVED_DAILY_USAGE_KWH
    ) {
        estimatedDailyUsageKwh = previousEstimate * 0.8 + observedDailyUsage * 0.2
    }
  }

  const distanceToThreshold = record.remainingKwh - thresholdKwh

  // 低于阈值：进入 notified 模式，一天后再检查，并记录当前低电量周期起点。
  if (distanceToThreshold <= 0) {
    scheduleMode = 'notified'
    nextCheckAt = new Date(now.getTime() + ONE_DAY_MS)
    lowPowerNotifiedAt = previousMode === 'notified' && !rechargeDetected && lowPowerNotifiedAt
      ? lowPowerNotifiedAt
      : record.queriedAt
  // 距阈值不超过 5 kWh：进入观察模式，一天后复查但暂不发送通知。
  } else if (distanceToThreshold <= NEAR_THRESHOLD_BAND_KWH) {
    scheduleMode = 'near_threshold'
    nextCheckAt = new Date(now.getTime() + ONE_DAY_MS)
    lowPowerNotifiedAt = null
  } else {
    // 电量充足时，根据“距离阈值 / 日耗 - 安全余量”安排下一次检查。
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

async function getPreviousSuccessfulPowerRecords(db, meterId) {
  // 只读取该电表最近的定时成功记录，供日耗估算使用。
  try {
    const result = await db.collection(COLLECTIONS.powerRecords)
      .where({
        meterId,
      })
      .orderBy('queriedAt', 'desc')
      .limit(50)
      .get()

    return result.data
      .filter((record) => isSuccessfulScheduledPowerRecord(record))
      .sort((left, right) => asDate(right.queriedAt).getTime() - asDate(left.queriedAt).getTime())
  } catch (error) {
    console.warn('Failed to read previous power record', {
      meterId,
      error,
    })
    return []
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

async function queryMeter(meter, type) {
  // 执行一块电表的上游查询，并把网络/解析失败转换成标准失败记录。
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
  // 把查询结果和调度计算结果写回 meters；已有文档更新，没有文档则创建。
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
  // 找出仍开启提醒且绑定这块电表的用户。
  const field = type === 'ac' ? 'acMeterId' : 'lightMeterId'
  const result = await db.collection(COLLECTIONS.userConfigs).where({
    [field]: meterId,
    reminderEnabled: true,
  }).get()

  return result.data
}

async function recordNotification(db, input) {
  // 保存通知结果，哪怕发送失败或被跳过，也保留审计记录。
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
  // 只有开启提醒、邮箱合法、查询成功且电量不高于阈值时才发送。
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
  // 同一个低电量周期只发一次成功邮件；充值后 lowPowerNotifiedAt 会被重置。
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
  // 通过另一个云函数发送邮件，避免把 SMTP 细节放进巡检执行器。
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
  // 逐个用户判断是否需要通知，并统计 sent/failed/skipped 三类结果。
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
  // 单块电表的完整处理：查询 -> 读取历史 -> 写查询记录 -> 更新电表 -> 发送通知。
  const type = getMeterType(meter)
  const record = await queryMeter(meter, type)
  const previousRecords = await getPreviousSuccessfulPowerRecords(db, record.meterId)
  const previousRecord = previousRecords[0]
  const estimateBaseRecord = findEstimateBaseRecord(previousRecords, record)
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
    estimateBaseRecord,
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
  // 优先按任务保存的 meterDocId 读取；兼容旧任务时退回 meterId + type 查询。
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
  // 用条件更新把 pending 原子改成 running，防止多个分发 worker 重复执行同一任务。
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
  // 任务执行入口：读取任务、检查状态、抢占任务、处理电表，最后标记 done 或 failed。
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
  calculateScheduleState,
  executePlannedJob,
  findEstimateBaseRecord,
  getPreviousSuccessfulPowerRecords,
  updateMeter,
}
