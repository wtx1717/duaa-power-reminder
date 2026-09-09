// 定时巡检计划器。
// 它只负责挑选电表并生成任务，不负责真正请求上游页面。
const MAX_METERS_PER_PLAN = 50
const PLAN_WINDOW_MS = 25 * 60 * 1000
const PLAN_DEADLINE_MS = 30 * 60 * 1000
const ACTIVE_JOB_STATUSES = ['pending', 'running']

function getMeterType(meter) {
  // 非 ac 的值按照照明处理，兼容旧数据或缺少 type 的记录。
  return meter && meter.type === 'ac' ? 'ac' : 'light'
}

function shuffleMeters(meters) {
  // Fisher-Yates 洗牌：复制数组后随机交换，避免改变数据库查询结果原数组。
  const shuffled = meters.slice()

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = current
  }

  return shuffled
}

function buildPlannedJobs(meters, now, runIdPrefix = 'scheduledCheck') {
  // 把电表均匀分到时间桶中，每块电表在自己的桶内随机执行，减少瞬时请求峰值。
  if (!meters.length) {
    return []
  }

  const runId = `${runIdPrefix}-${now.getTime()}-${Math.random().toString(16).slice(2)}`
  const bucketSize = PLAN_WINDOW_MS / meters.length
  const deadlineAt = new Date(now.getTime() + PLAN_DEADLINE_MS)

  return shuffleMeters(meters).map((meter, index) => {
    const bucketStart = Math.floor(index * bucketSize)
    const bucketEnd = Math.floor((index + 1) * bucketSize)
    const bucketWidth = Math.max(1, bucketEnd - bucketStart)
    const plannedOffset = bucketStart + Math.floor(Math.random() * bucketWidth)

    return {
      meter,
      data: {
        meterDocId: meter._id || '',
        meterId: String(meter.meterId || '').trim(),
        type: getMeterType(meter),
        status: 'pending',
        runId,
        plannedAt: new Date(now.getTime() + plannedOffset),
        deadlineAt,
        attempts: 0,
      },
    }
  })
}

function selectMetersToPlan(dueMeters, activeJobs) {
  // 已有 pending/running 任务或正在清理的电表不能重复加入新计划。
  return dueMeters.filter((meter) => {
    const meterId = String(meter.meterId || '').trim()
    return meterId && meter.cleanupPending !== true && !activeJobs.has(meterId)
  })
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  MAX_METERS_PER_PLAN,
  PLAN_DEADLINE_MS,
  PLAN_WINDOW_MS,
  buildPlannedJobs,
  selectMetersToPlan,
}
