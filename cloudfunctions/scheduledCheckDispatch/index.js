const cloud = require('wx-server-sdk')
const { executePlannedJob, asDate } = require('./shared/scheduledExecutor')
const { canDispatchScheduledJob } = require('./shared/workingHours')
const { ACTIVE_JOB_STATUSES } = require('./shared/scheduledPlanner')

const COLLECTIONS = {
  meterCheckJobs: 'meter_check_jobs',
}

const MAX_JOBS_PER_DISPATCH = 10
const DISPATCH_CONCURRENCY = 4

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function isCollectionNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist|meter_check_jobs/i.test(message)
}

async function getDueJobs(db) {
  const _ = db.command

  try {
    return await db.collection(COLLECTIONS.meterCheckJobs)
      .where({
        status: 'pending',
        plannedAt: _.lte(new Date()),
      })
      .orderBy('plannedAt', 'asc')
      .limit(MAX_JOBS_PER_DISPATCH)
      .get()
  } catch (error) {
    if (isCollectionNotFoundError(error)) {
      return {
        data: [],
      }
    }

    throw error
  }
}

async function expireStaleJobs(db) {
  const _ = db.command

  try {
    let updated = 0

    for (const status of ACTIVE_JOB_STATUSES) {
      const result = await db.collection(COLLECTIONS.meterCheckJobs)
        .where({
          status,
          deadlineAt: _.lt(new Date()),
        })
        .update({
          data: {
            status: 'expired',
            error: 'Job expired before completion',
            finishedAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })

      updated += result && result.stats && result.stats.updated ? result.stats.updated : 0
    }

    return updated
  } catch (error) {
    if (isCollectionNotFoundError(error)) {
      return 0
    }

    throw error
  }
}

async function markExpired(db, job) {
  await db.collection(COLLECTIONS.meterCheckJobs).doc(job._id).update({
    data: {
      status: 'expired',
      error: 'Job expired before dispatch',
      finishedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  })
}

function createJobSummary() {
  return {
    checkedMeters: 0,
    failedJobs: 0,
    expiredJobs: 0,
    sentNotifications: 0,
    failedNotifications: 0,
    skippedNotifications: 0,
    errors: [],
  }
}

function mergeJobSummary(result, summary) {
  result.checkedMeters += summary.checkedMeters || 0
  result.failedJobs += summary.failedJobs || 0
  result.expiredJobs += summary.expiredJobs || 0
  result.sentNotifications += summary.sentNotifications || 0
  result.failedNotifications += summary.failedNotifications || 0
  result.skippedNotifications += summary.skippedNotifications || 0

  if (Array.isArray(summary.errors) && summary.errors.length) {
    result.errors.push(...summary.errors)
  }
}

async function runJobsWithConcurrency(jobs, concurrency, handler) {
  const results = []
  let nextJobIndex = 0
  let shouldStop = false
  const workerCount = Math.min(concurrency, jobs.length)

  async function worker() {
    while (true) {
      if (shouldStop) {
        return
      }

      const jobIndex = nextJobIndex
      nextJobIndex += 1

      if (jobIndex >= jobs.length) {
        return
      }

      if (shouldStop) {
        return
      }

      const outcome = await handler(jobs[jobIndex], {
        shouldStop: () => shouldStop,
        stop: () => {
          shouldStop = true
        },
      })

      if (outcome && outcome.stats) {
        results.push(outcome.stats)
      }

      if (outcome && outcome.stopped) {
        shouldStop = true
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return {
    results,
    shouldStop,
  }
}

exports.main = async () => {
  const db = cloud.database()
  const result = {
    ok: true,
    checkedMeters: 0,
    failedJobs: 0,
    expiredJobs: 0,
    sentNotifications: 0,
    failedNotifications: 0,
    skippedNotifications: 0,
    errors: [],
  }

  if (!canDispatchScheduledJob(new Date())) {
    return {
      ...result,
      skipped: true,
      reason: 'outside_working_hours',
    }
  }

  result.expiredJobs += await expireStaleJobs(db)
  const jobs = await getDueJobs(db)
  const { results: jobSummaries, shouldStop } = await runJobsWithConcurrency(
    jobs.data,
    DISPATCH_CONCURRENCY,
    async (job, control) => {
      const summary = createJobSummary()

      if (control.shouldStop()) {
        return {
          stats: summary,
          stopped: true,
        }
      }

      const jobNow = new Date()

      if (!canDispatchScheduledJob(jobNow)) {
        control.stop()
        return {
          stats: summary,
          stopped: true,
        }
      }

      const deadlineAt = asDate(job.deadlineAt)

      if (deadlineAt && deadlineAt < jobNow) {
        try {
          await markExpired(db, job)
          summary.expiredJobs += 1
        } catch (error) {
          summary.failedJobs += 1
          summary.errors.push({
            jobId: job._id,
            meterId: job.meterId,
            error: error instanceof Error ? error.message : String(error),
          })
        }

        return {
          stats: summary,
        }
      }

      try {
        const jobResult = await executePlannedJob(db, job._id)

        if (jobResult.status === 'done') {
          summary.checkedMeters += jobResult.checkedMeters || 0
          summary.sentNotifications += jobResult.sentNotifications || 0
          summary.failedNotifications += jobResult.failedNotifications || 0
          summary.skippedNotifications += jobResult.skippedNotifications || 0
        } else if (jobResult.status === 'expired') {
          summary.expiredJobs += 1
        } else if (jobResult.status === 'failed') {
          summary.failedJobs += 1
          summary.errors.push({
            jobId: job._id,
            meterId: job.meterId,
            error: jobResult.error || 'Failed to execute planned job',
          })
        }
      } catch (error) {
        summary.failedJobs += 1
        summary.errors.push({
          jobId: job._id,
          meterId: job.meterId,
          error: error instanceof Error ? error.message : String(error),
        })
      }

      return {
        stats: summary,
      }
    },
  )

  for (const summary of jobSummaries) {
    mergeJobSummary(result, summary)
  }

  if (shouldStop) {
    result.skipped = true
    result.reason = 'outside_working_hours'
  }

  return result
}
