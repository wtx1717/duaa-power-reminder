const cloud = require('wx-server-sdk')
const {
  ACTIVE_JOB_STATUSES,
  MAX_METERS_PER_PLAN,
  buildPlannedJobs,
  selectMetersToPlan,
} = require('./shared/scheduledPlanner')
const { executePlannedJob } = require('./shared/scheduledExecutor')
const {
  canDispatchScheduledJob,
  canPlanScheduledCheck,
} = require('./shared/workingHours')

const COLLECTIONS = {
  meters: 'meters',
  jobLocks: 'job_locks',
  meterCheckJobs: 'meter_check_jobs',
}

const LOCK_NAME = 'scheduledCheck'
const LOCK_TTL_MS = 10 * 60 * 1000

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
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist|job_locks|meter_check_jobs/i.test(message)
}

async function ensureCollection(db, collectionName) {
  if (typeof db.createCollection !== 'function') {
    return
  }

  try {
    await db.createCollection(collectionName)
  } catch (error) {
    if (!/already exists|collection exists/i.test(error instanceof Error ? error.message : String(error))) {
      throw error
    }
  }
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
        await ensureCollection(db, COLLECTIONS.jobLocks)

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
    .limit(MAX_METERS_PER_PLAN)
    .get()
}

async function getActiveJobsByMeterId(db, meterIds) {
  if (!meterIds.length) {
    return new Map()
  }

  const _ = db.command
  const now = new Date()

  try {
    const jobs = []

    for (const status of ACTIVE_JOB_STATUSES) {
      const result = await db.collection(COLLECTIONS.meterCheckJobs)
        .where({
          meterId: _.in(meterIds),
          status,
        })
        .limit(MAX_METERS_PER_PLAN)
        .get()

      jobs.push(...result.data)
    }

    return new Map(jobs
      .filter((job) => {
        const deadlineAt = asDate(job.deadlineAt)
        return !deadlineAt || deadlineAt >= now
      })
      .map((job) => [job.meterId, job]))
  } catch (error) {
    if (isCollectionNotFoundError(error)) {
      await ensureCollection(db, COLLECTIONS.meterCheckJobs)
      return new Map()
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
      await ensureCollection(db, COLLECTIONS.meterCheckJobs)
      return 0
    }

    throw error
  }
}

async function addMeterCheckJob(db, job) {
  const now = db.serverDate()
  const data = {
    ...job.data,
    createdAt: now,
    updatedAt: now,
  }

  try {
    await db.collection(COLLECTIONS.meterCheckJobs).add({ data })
  } catch (error) {
    if (!isCollectionNotFoundError(error)) {
      throw error
    }

    await ensureCollection(db, COLLECTIONS.meterCheckJobs)
    await db.collection(COLLECTIONS.meterCheckJobs).add({ data })
  }
}

async function planDueMeterChecks(db) {
  const now = new Date()
  await expireStaleJobs(db)
  const dueMeters = await getDueMeters(db)
  const meterIds = dueMeters.data
    .map((meter) => String(meter.meterId || '').trim())
    .filter(Boolean)
  const activeJobs = await getActiveJobsByMeterId(db, meterIds)
  const metersToPlan = selectMetersToPlan(dueMeters.data, activeJobs)
  const jobs = buildPlannedJobs(metersToPlan, now)

  for (const job of jobs) {
    await addMeterCheckJob(db, job)
  }

  return {
    plannedMeters: jobs.length,
    dueMeters: dueMeters.data.length,
    skippedActiveJobs: dueMeters.data.length - metersToPlan.length,
  }
}

exports.main = async (event = {}) => {
  const db = cloud.database()

  if (event && event.action === 'executeJob') {
    if (!canDispatchScheduledJob(new Date())) {
      return {
        checkedMeters: 0,
        sentNotifications: 0,
        failedNotifications: 0,
        skippedNotifications: 0,
        status: 'skipped',
        skipped: true,
        reason: 'outside_working_hours',
      }
    }

    return executePlannedJob(db, event.jobId)
  }

  if (!canPlanScheduledCheck(new Date())) {
    return {
      ok: true,
      skipped: true,
      reason: 'outside_working_hours',
      locked: false,
      checkedMeters: 0,
      plannedMeters: 0,
      skippedActiveJobs: 0,
      sentNotifications: 0,
      failedNotifications: 0,
      skippedNotifications: 0,
      errors: [],
    }
  }

  const lock = await acquireJobLock(db)

  if (!lock.acquired) {
    return {
      ok: true,
      locked: true,
      checkedMeters: 0,
      plannedMeters: 0,
      skippedActiveJobs: 0,
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
    plannedMeters: 0,
    skippedActiveJobs: 0,
    sentNotifications: 0,
    failedNotifications: 0,
    skippedNotifications: 0,
    errors: [],
  }

  try {
    const planResult = await planDueMeterChecks(db)
    result.plannedMeters = planResult.plannedMeters
    result.dueMeters = planResult.dueMeters
    result.skippedActiveJobs = planResult.skippedActiveJobs
  } finally {
    await releaseJobLock(db, lock)
  }

  return result
}
