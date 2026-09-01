const MAX_METERS_PER_PLAN = 50
const PLAN_WINDOW_MS = 25 * 60 * 1000
const PLAN_DEADLINE_MS = 30 * 60 * 1000
const ACTIVE_JOB_STATUSES = ['pending', 'running']

function getMeterType(meter) {
  return meter && meter.type === 'ac' ? 'ac' : 'light'
}

function shuffleMeters(meters) {
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
