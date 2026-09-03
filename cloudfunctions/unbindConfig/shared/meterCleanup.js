const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
  meterCheckJobs: 'meter_check_jobs',
}

const ACTIVE_JOB_STATUSES = new Set(['pending', 'running'])

function getErrorDetails(error) {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const value = error
    const fields = [
      value.code,
      value.errCode,
      value.errorCode,
      value.message,
      value.errMsg,
    ].filter((item) => typeof item === 'string' || typeof item === 'number')

    if (fields.length) {
      return fields.join(' ')
    }
  }

  try {
    return JSON.stringify(error)
  } catch (_serializationError) {
    return String(error)
  }
}

function isCollectionNotFoundError(error) {
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist|meter_check_jobs/i.test(
    getErrorDetails(error),
  )
}

function isDocumentNotFoundError(error) {
  return /DATABASE_DOCUMENT_NOT_EXIST|document not exist|document does not exist|document not found/i.test(
    getErrorDetails(error),
  )
}

function getBindingField(type) {
  return type === 'ac' ? 'acMeterId' : 'lightMeterId'
}

async function findOtherBindings(db, target, openid) {
  const field = getBindingField(target.type)

  try {
    const result = await db.collection(COLLECTIONS.userConfigs).where({ [field]: target.meterId }).get()
    return result.data.filter((config) => Boolean(config.openid) && config.openid !== openid)
  } catch (error) {
    throw new Error(`查询其他用户绑定失败：${getErrorDetails(error)}`)
  }
}

async function getMeter(db, meterId) {
  try {
    const result = await db.collection(COLLECTIONS.meters).where({ meterId }).get()
    return result.data[0]
  } catch (error) {
    throw new Error(`查询电表失败：${getErrorDetails(error)}`)
  }
}

async function getMeterJobs(db, meterId) {
  try {
    const result = await db.collection(COLLECTIONS.meterCheckJobs).where({ meterId }).get()
    return result.data
  } catch (error) {
    if (isCollectionNotFoundError(error)) {
      return []
    }

    throw new Error(`查询调度任务失败：${getErrorDetails(error)}`)
  }
}

async function updateMeter(db, meter, data) {
  if (!meter || !meter._id) {
    return
  }

  try {
    await db.collection(COLLECTIONS.meters).doc(meter._id).update({ data })
  } catch (error) {
    throw new Error(`电表清理失败：${getErrorDetails(error)}`)
  }
}

async function expirePendingJobs(db, jobs) {
  let expiredJobs = 0

  try {
    for (const job of jobs) {
      if (job.status !== 'pending' || !job._id) {
        continue
      }

      await db.collection(COLLECTIONS.meterCheckJobs).doc(job._id).update({
        data: {
          status: 'expired',
          error: '电表已解绑',
          finishedAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      })
      expiredJobs += 1
    }
  } catch (error) {
    throw new Error(`调度任务处理失败：${getErrorDetails(error)}`)
  }

  return expiredJobs
}

async function markCleanupPending(db, meter) {
  await updateMeter(db, meter, {
    cleanupPending: true,
    cleanupReason: '电表已解绑，存在运行中的调度任务',
    updatedAt: db.serverDate(),
  })
}

async function removeMeter(db, meter) {
  if (!meter || !meter._id) {
    return
  }

  try {
    await db.collection(COLLECTIONS.meters).doc(meter._id).remove()
  } catch (error) {
    if (isDocumentNotFoundError(error)) {
      return
    }

    throw new Error(`电表清理失败：${getErrorDetails(error)}`)
  }
}

async function cleanMeter(db, target, openid) {
  let otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs: 0 }
  }

  const meter = await getMeter(db, target.meterId)
  if (!meter) {
    return { action: 'cleaned', expiredJobs: 0 }
  }

  let jobs = await getMeterJobs(db, target.meterId)
  if (jobs.some((job) => job.status === 'running')) {
    otherBindings = await findOtherBindings(db, target, openid)
    if (otherBindings.length) {
      return { action: 'retained', expiredJobs: 0 }
    }

    const expiredJobs = await expirePendingJobs(db, jobs)
    await markCleanupPending(db, meter)
    return { action: 'cleanup_pending', expiredJobs }
  }

  otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs: 0 }
  }

  const expiredJobs = await expirePendingJobs(db, jobs)
  jobs = await getMeterJobs(db, target.meterId)

  otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs }
  }

  if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))) {
    await markCleanupPending(db, meter)
    return { action: 'cleanup_pending', expiredJobs }
  }

  const finalMeter = await getMeter(db, target.meterId)
  if (!finalMeter) {
    return { action: 'cleaned', expiredJobs }
  }

  otherBindings = await findOtherBindings(db, target, openid)
  if (otherBindings.length) {
    return { action: 'retained', expiredJobs }
  }

  await removeMeter(db, finalMeter)
  return { action: 'cleaned', expiredJobs }
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  cleanMeter,
  findOtherBindings,
  getBindingField,
  getErrorDetails,
  getMeter,
  getMeterJobs,
  isCollectionNotFoundError,
  isDocumentNotFoundError,
}
