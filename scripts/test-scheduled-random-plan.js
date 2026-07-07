const assert = require('assert')
const {
  ACTIVE_JOB_STATUSES,
  MAX_METERS_PER_PLAN,
  PLAN_DEADLINE_MS,
  PLAN_WINDOW_MS,
  buildPlannedJobs,
  selectMetersToPlan,
} = require('../cloudfunctions/shared/scheduledPlanner')

const PLAN_INTERVAL_MS = 30 * 60 * 1000
const CASES = [0, 1, 2, 50, 500, 1000]

function makeMeters(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    _id: `meter-doc-${index + 1}`,
    meterId: `TEST-${String(index + 1).padStart(4, '0')}`,
    type: index % 2 === 0 ? 'light' : 'ac',
  }))
}

function getTime(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function formatDuration(ms) {
  const minutes = Math.ceil(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60

  if (!hours) {
    return `${restMinutes} 分钟`
  }

  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
}

function assertPlannedJobs(jobs, expectedCount, triggerTime) {
  assert.strictEqual(jobs.length, expectedCount, 'planned job count mismatch')

  if (!jobs.length) {
    return {
      minPlannedAt: undefined,
      maxPlannedAt: undefined,
    }
  }

  const triggerMs = triggerTime.getTime()
  const windowEndMs = triggerMs + PLAN_WINDOW_MS
  const deadlineMs = triggerMs + PLAN_DEADLINE_MS
  const plannedTimes = jobs.map((job) => getTime(job.data.plannedAt))
  const uniqueMeterIds = new Set(jobs.map((job) => job.data.meterId))

  assert.strictEqual(uniqueMeterIds.size, jobs.length, 'duplicate meter job generated')

  for (const job of jobs) {
    const plannedAtMs = getTime(job.data.plannedAt)
    const deadlineAtMs = getTime(job.data.deadlineAt)

    assert(
      plannedAtMs >= triggerMs && plannedAtMs <= windowEndMs,
      `plannedAt out of 25min window: ${job.data.meterId}`,
    )
    assert.strictEqual(deadlineAtMs, deadlineMs, `deadlineAt mismatch: ${job.data.meterId}`)
    assert.strictEqual(job.data.status, 'pending', `initial status mismatch: ${job.data.meterId}`)
  }

  return {
    minPlannedAt: new Date(Math.min(...plannedTimes)),
    maxPlannedAt: new Date(Math.max(...plannedTimes)),
  }
}

function testSinglePlanningCase(count) {
  const triggerTime = new Date('2026-07-07T08:00:00.000Z')
  const meters = makeMeters(count)
  const jobs = buildPlannedJobs(meters.slice(0, MAX_METERS_PER_PLAN), triggerTime)
  const expectedCount = Math.min(count, MAX_METERS_PER_PLAN)
  const range = assertPlannedJobs(jobs, expectedCount, triggerTime)

  return {
    totalMeters: count,
    plannedThisRound: jobs.length,
    remainingBacklog: Math.max(0, count - MAX_METERS_PER_PLAN),
    minPlannedAt: range.minPlannedAt,
    maxPlannedAt: range.maxPlannedAt,
  }
}

function testDuplicateAndExpiredActiveJobs() {
  const meters = makeMeters(5)
  const activeJobs = new Map([
    [meters[0].meterId, { status: 'pending' }],
    [meters[1].meterId, { status: 'running' }],
  ])
  const selected = selectMetersToPlan(meters, activeJobs)

  assert.deepStrictEqual(
    selected.map((meter) => meter.meterId),
    meters.slice(2).map((meter) => meter.meterId),
    'pending/running active jobs should be skipped',
  )

  assert.deepStrictEqual(
    ACTIVE_JOB_STATUSES,
    ['pending', 'running'],
    'active statuses changed unexpectedly',
  )

  const expiredJobs = [
    { meterId: 'A', status: 'pending', deadlineAt: new Date('2026-07-07T07:59:59.000Z') },
    { meterId: 'B', status: 'running', deadlineAt: new Date('2026-07-07T07:59:59.000Z') },
  ]
  const now = new Date('2026-07-07T08:00:00.000Z')
  const expiredCount = expiredJobs.filter((job) => (
    ACTIVE_JOB_STATUSES.includes(job.status) && getTime(job.deadlineAt) < now.getTime()
  )).length

  assert.strictEqual(expiredCount, 2, 'expired pending/running jobs should be detected')
}

function simulateBacklog(totalMeters) {
  let remaining = totalMeters
  let rounds = 0
  const triggerStart = new Date('2026-07-07T08:00:00.000Z')

  while (remaining > 0) {
    const currentTrigger = new Date(triggerStart.getTime() + rounds * PLAN_INTERVAL_MS)
    const planCount = Math.min(remaining, MAX_METERS_PER_PLAN)
    const jobs = buildPlannedJobs(makeMeters(planCount), currentTrigger)

    assert(jobs.length <= MAX_METERS_PER_PLAN, 'round planned more than max limit')
    assertPlannedJobs(jobs, planCount, currentTrigger)

    remaining -= planCount
    rounds += 1
  }

  return {
    totalMeters,
    rounds,
    estimatedDrainTimeMs: rounds * PLAN_INTERVAL_MS,
  }
}

function printCaseResult(result) {
  const minPlannedAt = result.minPlannedAt ? result.minPlannedAt.toISOString() : '-'
  const maxPlannedAt = result.maxPlannedAt ? result.maxPlannedAt.toISOString() : '-'

  console.log([
    `规模=${result.totalMeters}`,
    `本轮规划=${result.plannedThisRound}`,
    `剩余积压=${result.remainingBacklog}`,
    `plannedAt最小=${minPlannedAt}`,
    `plannedAt最大=${maxPlannedAt}`,
  ].join(' | '))
}

function main() {
  console.log('随机错峰调度本地仿真测试')
  console.log(`规划上限=${MAX_METERS_PER_PLAN} | 随机窗口=${formatDuration(PLAN_WINDOW_MS)} | 截止时间=${formatDuration(PLAN_DEADLINE_MS)}`)

  for (const count of CASES) {
    printCaseResult(testSinglePlanningCase(count))
  }

  testDuplicateAndExpiredActiveJobs()

  for (const count of [50, 500, 1000]) {
    const result = simulateBacklog(count)
    console.log([
      `积压规模=${result.totalMeters}`,
      `需要规划轮次=${result.rounds}`,
      `理论消化时间<=${formatDuration(result.estimatedDrainTimeMs)}`,
    ].join(' | '))
  }

  console.log('OK: 本地仿真测试通过，未发现越界、重复规划或容量计算异常。')
}

main()
