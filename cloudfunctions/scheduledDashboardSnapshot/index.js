const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
  powerRecords: 'power_records',
  notificationRecords: 'notification_records',
  meterCheckJobs: 'meter_check_jobs',
  snapshots: 'ops_dashboard_snapshots',
}

const TIME_ZONE = 'Asia/Shanghai'
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_THRESHOLD_KWH = 20
const MAX_QUERY_LIMIT = 1000

const TYPE_LABEL = {
  light: '照明',
  ac: '空调',
}

const STATE_LABEL = {
  normal: '正常',
  warn: '预警',
  monitor: '待检查',
  error: '异常',
}

const JOB_STATUS_LABEL = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  expired: '已过期',
}

const SNAPSHOT_STATUS = {
  success: 'success',
  partial: 'partial',
  failed: 'failed',
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

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

function isoOrEmpty(value) {
  const date = asDate(value)
  return date ? date.toISOString() : ''
}

function getBeijingDateParts(value) {
  const date = asDate(value) || new Date()
  const beijingDate = new Date(date.getTime() + BEIJING_OFFSET_MS)

  return {
    year: beijingDate.getUTCFullYear(),
    month: beijingDate.getUTCMonth(),
    day: beijingDate.getUTCDate(),
  }
}

function formatSnapshotDate(value) {
  const parts = typeof value === 'string' && isValidSnapshotDate(value)
    ? { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)) - 1, day: Number(value.slice(8, 10)) }
    : getBeijingDateParts(value)

  return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function isValidSnapshotDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function getSnapshotDate(value) {
  if (value && isValidSnapshotDate(value.snapshotDate)) {
    return formatSnapshotDate(value.snapshotDate)
  }

  return formatSnapshotDate(new Date())
}

function getBeijingDayRange(snapshotDate) {
  if (!isValidSnapshotDate(snapshotDate)) {
    throw new Error(`无效的快照日期：${snapshotDate}`)
  }

  const [year, month, day] = snapshotDate.split('-').map(Number)
  const start = new Date(Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS)

  return {
    startAt: start,
    endAt: new Date(start.getTime() + ONE_DAY_MS),
  }
}

function getMeterState(meter) {
  if (Number(meter.failCount) >= 3 || Number(meter.lastRemainingKwh) <= 10) {
    return 'error'
  }

  if (Number(meter.lastRemainingKwh) <= 25) {
    return 'warn'
  }

  if (meter.scheduleMode === 'near_threshold' || Number(meter.failCount) > 0) {
    return 'monitor'
  }

  return 'normal'
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '-'
}

function sortByDateDesc(field) {
  return (left, right) => {
    const leftTime = asDate(left && left[field])
    const rightTime = asDate(right && right[field])
    return (rightTime ? rightTime.getTime() : 0) - (leftTime ? leftTime.getTime() : 0)
  }
}

function groupByMeter(records) {
  return (Array.isArray(records) ? records : []).reduce((result, record) => {
    const meterId = String(record.meterId || '').trim()
    if (!meterId) {
      return result
    }

    if (!result[meterId]) {
      result[meterId] = []
    }
    result[meterId].push(record)
    return result
  }, {})
}

function toMeterSnapshot(meter, queriesByMeter, notificationsByMeter) {
  const meterId = String(meter.meterId || '').trim()
  const queries = (queriesByMeter[meterId] || []).slice().sort(sortByDateDesc('queriedAt'))
  const notifications = (notificationsByMeter[meterId] || []).slice().sort(sortByDateDesc('sentAt'))
  const latestQuery = queries[0]
  const currentKwh = Number.isFinite(Number(meter.lastRemainingKwh))
    ? Number(meter.lastRemainingKwh)
    : null
  const dailyUsageKwh = Number.isFinite(Number(meter.estimatedDailyUsageKwh))
    ? Number(meter.estimatedDailyUsageKwh)
    : null
  const type = meter.type === 'ac' ? 'ac' : 'light'
  const state = getMeterState(meter)

  return {
    meterId,
    type,
    typeText: TYPE_LABEL[type],
    state,
    stateText: STATE_LABEL[state],
    currentKwh,
    currentText: currentKwh === null ? '-' : `${formatNumber(currentKwh)} kWh`,
    dailyUsageKwh,
    dailyText: dailyUsageKwh === null ? '-' : `${formatNumber(dailyUsageKwh, dailyUsageKwh % 1 === 0 ? 0 : 1)} kWh`,
    failCount: Number(meter.failCount) || 0,
    nextCheckAt: isoOrEmpty(meter.nextCheckAt),
    queriedAt: isoOrEmpty(meter.lastQueriedAt),
    scheduleMode: meter.scheduleMode || 'normal',
    lastError: String(meter.lastError || ''),
    latestAddress: String((latestQuery && latestQuery.address) || ''),
    latestCutoffTime: String((latestQuery && latestQuery.cutoffTime) || ''),
    queryCount: queries.length,
    notifyCount: notifications.length,
  }
}

function normalizePowerRecord(record) {
  const type = record.type === 'ac' ? 'ac' : 'light'
  const result = {
    meterId: String(record.meterId || '').trim(),
    type,
    ok: record.ok === true,
    queriedAt: isoOrEmpty(record.queriedAt),
    source: record.source === 'scheduledCheck' ? 'scheduledCheck' : 'queryPower',
  }

  if (record.remainingKwh !== undefined && Number.isFinite(Number(record.remainingKwh))) {
    result.remainingKwh = Number(record.remainingKwh)
  }
  if (record.cutoffTime) result.cutoffTime = String(record.cutoffTime)
  if (record.address) result.address = String(record.address)
  if (record.error) result.error = String(record.error)

  return result
}

function normalizeNotificationRecord(record) {
  const type = record.type === 'ac' ? 'ac' : 'light'
  return {
    meterId: String(record.meterId || '').trim(),
    type,
    remainingKwh: Number(record.remainingKwh) || 0,
    thresholdKwh: Number(record.thresholdKwh) || DEFAULT_THRESHOLD_KWH,
    sentAt: isoOrEmpty(record.sentAt),
    status: ['pending', 'sent', 'failed', 'skipped'].includes(record.status) ? record.status : 'failed',
    channel: 'email',
    source: record.source === 'queryPower' ? 'queryPower' : 'scheduledCheck',
    email: record.email ? String(record.email) : '',
    error: record.error ? String(record.error) : '',
  }
}

function normalizeJobRecord(job) {
  const status = ['pending', 'running', 'done', 'failed', 'expired'].includes(job.status)
    ? job.status
    : 'failed'

  return {
    jobId: String(job._id || ''),
    meterId: String(job.meterId || '').trim(),
    type: job.type === 'ac' ? 'ac' : 'light',
    status,
    statusText: JOB_STATUS_LABEL[status],
    runId: String(job.runId || ''),
    plannedAt: isoOrEmpty(job.plannedAt),
    startedAt: isoOrEmpty(job.startedAt),
    finishedAt: isoOrEmpty(job.finishedAt),
    attempts: Number(job.attempts) || 0,
    error: String(job.error || ''),
  }
}

function buildStateCounts(meters) {
  return meters.reduce((counts, meter) => {
    counts[meter.state] += 1
    return counts
  }, { normal: 0, warn: 0, monitor: 0, error: 0 })
}

function buildKpis(userCount, meters, powerRecords, jobs, notifications, stateCounts) {
  const completedJobs = jobs.filter((job) => job.status === 'done').length
  const completionRate = jobs.length ? Math.round((completedJobs / jobs.length) * 100) : 0

  return [
    { label: '用户数量', value: String(userCount), foot: '已绑定账号' },
    { label: '电表总数量', value: String(meters.length), foot: '当前纳管' },
    { label: '今日查询总次数', value: String(powerRecords.length), foot: '含手动与定时' },
    { label: '今日规划任务数量', value: String(jobs.length), foot: '当日排程记录' },
    { label: '规划任务完成率', value: `${completionRate}%`, foot: '当日完成情况' },
    { label: '今日发送提醒', value: String(notifications.length), foot: '邮件通知' },
    { label: '异常数量', value: String(stateCounts.error), foot: '需要优先处理' },
  ]
}

function buildSummary(stateCounts) {
  return [
    { key: 'normal', title: '正常状态', count: stateCounts.normal, note: '运行稳定，按默认节奏巡检' },
    { key: 'warn', title: '预警状态', count: stateCounts.warn, note: '接近阈值，建议观察' },
    { key: 'monitor', title: '待检查', count: stateCounts.monitor, note: '已进入观察窗口' },
    { key: 'error', title: '异常状态', count: stateCounts.error, note: '优先处理与回溯' },
  ]
}

function sortMeters(meters) {
  const stateOrder = { error: 0, warn: 1, monitor: 2, normal: 3 }
  return meters.slice().sort((left, right) => {
    const stateDiff = stateOrder[left.state] - stateOrder[right.state]
    if (stateDiff !== 0) return stateDiff
    return (left.nextCheckAt || '').localeCompare(right.nextCheckAt || '')
  })
}

function isInRange(value, range) {
  const date = asDate(value)
  return date && date >= range.startAt && date < range.endAt
}

async function readCollection(db, collectionName, query = {}) {
  const reference = db.collection(collectionName)
  const records = []
  let offset = 0

  for (let page = 0; page < 100; page += 1) {
    let result = reference.where(query)

    if (offset > 0 && typeof result.skip === 'function') {
      result = result.skip(offset)
    }

    if (typeof result.limit === 'function') {
      result = result.limit(MAX_QUERY_LIMIT)
    }

    const response = await result.get()
    const pageData = Array.isArray(response.data) ? response.data : []
    records.push(...pageData)

    if (pageData.length < MAX_QUERY_LIMIT || typeof result.skip !== 'function') {
      break
    }

    offset += pageData.length
  }

  return records
}

async function readOptionalCollection(db, collectionName, query = {}) {
  try {
    return await readCollection(db, collectionName, query)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist/i.test(message)) {
      return []
    }
    throw error
  }
}

function filterAndNormalizeRecords(records, field, range, normalize) {
  return records
    .filter((record) => isInRange(record[field], range))
    .sort(sortByDateDesc(field))
    .map(normalize)
    .filter((record) => record.meterId)
}

async function buildSnapshot(db, snapshotDate, generatedAt = new Date()) {
  const range = getBeijingDayRange(snapshotDate)
  const [configs, meters, powerRecords, notificationRecords, jobs] = await Promise.all([
    readOptionalCollection(db, COLLECTIONS.userConfigs),
    readOptionalCollection(db, COLLECTIONS.meters),
    readOptionalCollection(db, COLLECTIONS.powerRecords),
    readOptionalCollection(db, COLLECTIONS.notificationRecords),
    readOptionalCollection(db, COLLECTIONS.meterCheckJobs),
  ])

  const dailyPowerRecords = filterAndNormalizeRecords(powerRecords, 'queriedAt', range, normalizePowerRecord)
  const dailyNotificationRecords = filterAndNormalizeRecords(notificationRecords, 'sentAt', range, normalizeNotificationRecord)
  const dailyJobRecords = filterAndNormalizeRecords(jobs, 'createdAt', range, normalizeJobRecord)
  const queriesByMeter = groupByMeter(dailyPowerRecords)
  const notificationsByMeter = groupByMeter(dailyNotificationRecords)
  const snapshotMeters = sortMeters(meters
    .map((meter) => toMeterSnapshot(meter, queriesByMeter, notificationsByMeter))
    .filter((meter) => meter.meterId))
  const stateCounts = buildStateCounts(snapshotMeters)
  const completedJobCount = dailyJobRecords.filter((job) => job.status === 'done').length
  const failedJobCount = dailyJobRecords.filter((job) => job.status === 'failed' || job.status === 'expired').length
  const completionRate = dailyJobRecords.length
    ? Math.round((completedJobCount / dailyJobRecords.length) * 100)
    : 0

  return {
    snapshotDate,
    generatedAt: generatedAt.toISOString(),
    timeZone: TIME_ZONE,
    status: SNAPSHOT_STATUS.success,
    sourceWindow: {
      startAt: range.startAt.toISOString(),
      endAt: range.endAt.toISOString(),
    },
    userCount: configs.length,
    meterCount: snapshotMeters.length,
    powerRecordCount: dailyPowerRecords.length,
    notificationRecordCount: dailyNotificationRecords.length,
    jobRecordCount: dailyJobRecords.length,
    completedJobCount,
    failedJobCount,
    completionRate,
    stateCounts,
    kpis: buildKpis(configs.length, snapshotMeters, dailyPowerRecords, dailyJobRecords, dailyNotificationRecords, stateCounts),
    summary: buildSummary(stateCounts),
    meters: snapshotMeters,
    powerRecords: dailyPowerRecords,
    notificationRecords: dailyNotificationRecords,
    jobRecords: dailyJobRecords,
  }
}

async function upsertSnapshot(db, snapshot) {
  let snapshots = db.collection(COLLECTIONS.snapshots)
  let existing = []

  try {
    existing = await readCollection(db, COLLECTIONS.snapshots, { snapshotDate: snapshot.snapshotDate })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist/i.test(message)) {
      if (typeof db.createCollection === 'function') {
        await db.createCollection(COLLECTIONS.snapshots).catch((createError) => {
          const createMessage = createError instanceof Error ? createError.message : String(createError)
          if (!/already exists|collection exists/i.test(createMessage)) throw createError
        })
      }
      snapshots = db.collection(COLLECTIONS.snapshots)
    } else {
      throw error
    }
  }

  const current = existing[0]
  if (current && current._id) {
    await snapshots.doc(current._id).set({ data: snapshot })
    return true
  }

  await snapshots.doc(snapshot.snapshotDate).set({ data: snapshot })
  return false
}

async function main(event = {}) {
  const snapshotDate = getSnapshotDate(event)
  const db = cloud.database()

  try {
    const snapshot = await buildSnapshot(db, snapshotDate)
    const replaced = await upsertSnapshot(db, snapshot)

    return {
      ok: true,
      snapshotDate,
      status: snapshot.status,
      replaced,
      meterCount: snapshot.meterCount,
      powerRecordCount: snapshot.powerRecordCount,
      notificationRecordCount: snapshot.notificationRecordCount,
      jobRecordCount: snapshot.jobRecordCount,
    }
  } catch (error) {
    return {
      ok: false,
      snapshotDate,
      status: SNAPSHOT_STATUS.failed,
      replaced: false,
      meterCount: 0,
      powerRecordCount: 0,
      notificationRecordCount: 0,
      jobRecordCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

module.exports = {
  SNAPSHOT_STATUS,
  buildSnapshot,
  formatSnapshotDate,
  getBeijingDayRange,
  getSnapshotDate,
  isValidSnapshotDate,
  main,
  upsertSnapshot,
}
