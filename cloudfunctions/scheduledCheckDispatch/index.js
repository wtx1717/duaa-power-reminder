const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  meterCheckJobs: 'meter_check_jobs',
}

const MAX_JOBS_PER_DISPATCH = 5
const ACTIVE_JOB_STATUSES = ['pending', 'running']

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

async function executeJob(jobId) {
  const response = await cloud.callFunction({
    name: 'scheduledCheck',
    data: {
      action: 'executeJob',
      jobId,
    },
  })

  return response && response.result ? response.result : {
    status: 'failed',
    error: 'Empty scheduledCheck response',
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
  result.expiredJobs += await expireStaleJobs(db)
  const jobs = await getDueJobs(db)
  const now = new Date()

  for (const job of jobs.data) {
    const deadlineAt = asDate(job.deadlineAt)

    if (deadlineAt && deadlineAt < now) {
      try {
        await markExpired(db, job)
        result.expiredJobs += 1
      } catch (error) {
        result.failedJobs += 1
        result.errors.push({
          jobId: job._id,
          meterId: job.meterId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      continue
    }

    try {
      const jobResult = await executeJob(job._id)

      if (jobResult.status === 'done') {
        result.checkedMeters += jobResult.checkedMeters || 0
        result.sentNotifications += jobResult.sentNotifications || 0
        result.failedNotifications += jobResult.failedNotifications || 0
        result.skippedNotifications += jobResult.skippedNotifications || 0
      } else if (jobResult.status === 'expired') {
        result.expiredJobs += 1
      } else if (jobResult.status === 'failed') {
        result.failedJobs += 1
        result.errors.push({
          jobId: job._id,
          meterId: job.meterId,
          error: jobResult.error || 'Failed to execute planned job',
        })
      }
    } catch (error) {
      result.failedJobs += 1
      result.errors.push({
        jobId: job._id,
        meterId: job.meterId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}
