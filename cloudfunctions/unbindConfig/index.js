// unbindConfig 云函数：删除用户配置和限流状态，并安全清理不再共享的电表。
const cloud = require('wx-server-sdk')
const { cleanMeter } = require('./shared/meterCleanup')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  userQueryState: 'user_query_state',
  meters: 'meters',
  meterCheckJobs: 'meter_check_jobs',
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function getErrorDetails(error) {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const fields = [
      error.code,
      error.errCode,
      error.errorCode,
      error.message,
      error.errMsg,
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

function normalizeMeterId(value) {
  return String(value || '').trim()
}

async function getUserConfigs(db, openid) {
  // 读取全部历史配置，兼容过去可能存在的重复配置记录。
  try {
    const result = await db.collection(COLLECTIONS.userConfigs).where({ openid }).get()
    return result.data
  } catch (error) {
    throw new Error(`查询用户配置失败：${getErrorDetails(error)}`)
  }
}

function collectTargets(configs) {
  // 按“电表类型 + 电表号”去重，避免重复清理同一目标。
  const targets = []
  const seen = new Set()

  for (const config of configs) {
    for (const type of ['light', 'ac']) {
      const meterId = normalizeMeterId(config[type === 'light' ? 'lightMeterId' : 'acMeterId'])
      const key = `${type}:${meterId}`

      if (meterId && !seen.has(key)) {
        seen.add(key)
        targets.push({ meterId, type })
      }
    }
  }

  return targets
}

async function deleteUserConfigs(db, configs) {
  // 删除配置时把“文档已经不存在”视为成功，从而保持解绑幂等。
  try {
    for (const config of configs) {
      if (config._id) {
        try {
          await db.collection(COLLECTIONS.userConfigs).doc(config._id).remove()
        } catch (error) {
          if (!isDocumentNotFoundError(error)) {
            throw error
          }
        }
      }
    }
  } catch (error) {
    throw new Error(`删除用户配置失败：${getErrorDetails(error)}`)
  }
}

async function deleteUserQueryState(db, openid) {
  // 删除手动查询限流状态；集合不存在时说明用户从未查询过，可直接忽略。
  try {
    const result = await db.collection(COLLECTIONS.userQueryState).where({ openid }).get()

    for (const item of result.data) {
      if (!item._id) {
        continue
      }

      try {
        await db.collection(COLLECTIONS.userQueryState).doc(item._id).remove()
      } catch (error) {
        if (!isDocumentNotFoundError(error)) {
          throw error
        }
      }
    }
  } catch (error) {
    if (!isCollectionNotFoundError(error)) {
      throw new Error(`删除手动查询状态失败：${getErrorDetails(error)}`)
    }
  }
}

exports.main = async () => {
  // 主流程：读取当前用户配置 -> 删除配置和限流状态 -> 逐块电表执行共享清理。
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    throw new Error('无法获取当前用户身份')
  }

  const db = cloud.database()
  const configs = await getUserConfigs(db, OPENID)

  if (!configs.length) {
    return {
      ok: true,
      status: 'already_unbound',
      cleanedMeters: [],
      retainedMeters: [],
      cleanupPendingMeters: [],
      expiredJobs: 0,
    }
  }

  const targets = collectTargets(configs)
  await deleteUserConfigs(db, configs)
  await deleteUserQueryState(db, OPENID)

  const cleanedMeters = []
  const retainedMeters = []
  const cleanupPendingMeters = []
  let expiredJobs = 0

  for (const target of targets) {
    const result = await cleanMeter(db, target, OPENID)
    expiredJobs += result.expiredJobs

    if (result.action === 'cleaned') {
      cleanedMeters.push(target.meterId)
    } else if (result.action === 'cleanup_pending') {
      cleanupPendingMeters.push(target.meterId)
    } else {
      retainedMeters.push(target.meterId)
    }
  }

  return {
    ok: true,
    status: 'unbound',
    cleanedMeters: Array.from(new Set(cleanedMeters)),
    retainedMeters: Array.from(new Set(retainedMeters)),
    cleanupPendingMeters: Array.from(new Set(cleanupPendingMeters)),
    expiredJobs,
  }
}
