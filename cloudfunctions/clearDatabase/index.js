// clearDatabase 云函数：手动清空项目维护的所有集合中的文档，但保留集合本身。
// 该函数没有 config.json，因此不会被定时触发；调用时还必须显式传入确认字符串。
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

// 这里列出项目实际使用的全部集合。新增集合时必须同步补充，否则该集合不会被清理。
const COLLECTIONS = [
  'user_configs',
  'user_query_state',
  'meters',
  'power_records',
  'notification_records',
  'meter_check_jobs',
  'job_locks',
  'ops_dashboard_snapshots',
]

// 必须在云函数环境变量中配置随机长字符串，避免源码中的固定口令被复用。
const CONFIRMATION_ENV_NAME = 'CLEAR_DATABASE_CONFIRMATION'

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
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist/i.test(
    getErrorDetails(error),
  )
}

function getRemovedCount(result) {
  // wx-server-sdk 通常返回 { stats: { removed } }；保留兼容分支便于不同 SDK 版本使用。
  const candidates = [
    result && result.stats && result.stats.removed,
    result && result.removed,
    result && result.deleted,
  ]

  for (const value of candidates) {
    const count = Number(value)
    if (Number.isFinite(count) && count >= 0) {
      return count
    }
  }

  return 0
}

async function clearCollection(db, collectionName) {
  try {
    const collection = db.collection(collectionName)
    let removed = 0

    // 分批读取并逐条删除，避免 SDK 的单次 remove 数量上限导致“只清掉一部分”。
    // 每轮都从头查询，直到集合中不再有文档；集合和索引始终保留。
    while (true) {
      const result = await collection.where({}).limit(100).get()
      const documents = Array.isArray(result.data) ? result.data : []

      if (!documents.length) {
        return {
          collection: collectionName,
          removed,
          skipped: false,
        }
      }

      await Promise.all(documents.map((document) => {
        if (!document || !document._id) {
          throw new Error(`集合 ${collectionName} 返回了缺少 _id 的文档`)
        }

        return collection.doc(document._id).remove()
      }))
      removed += documents.length
    }
  } catch (error) {
    // 可选集合尚未创建时视为已清空，避免首次部署后无法手动执行。
    if (isCollectionNotFoundError(error)) {
      return {
        collection: collectionName,
        removed: 0,
        skipped: true,
      }
    }

    throw new Error(`清空集合 ${collectionName} 失败：${getErrorDetails(error)}`)
  }
}

async function main(event) {
  const confirmation = String(process.env[CONFIRMATION_ENV_NAME] || '')

  // 不接受空调用或普通客户端调用，必须同时配置服务端密钥并传入它。
  if (!confirmation) {
    return {
      ok: false,
      status: 'server_configuration_required',
      message: `请先配置云函数环境变量 ${CONFIRMATION_ENV_NAME}。`,
    }
  }

  if (!event || event.confirm !== confirmation) {
    return {
      ok: false,
      status: 'confirmation_required',
      message: `为避免误删，请传入环境变量 ${CONFIRMATION_ENV_NAME} 对应的 confirm 值。`,
    }
  }

  const db = cloud.database()
  const collections = []

  // 顺序执行便于定位失败集合，也避免同时发起大量删除请求。
  for (const collectionName of COLLECTIONS) {
    try {
      collections.push(await clearCollection(db, collectionName))
    } catch (error) {
      return {
        ok: false,
        status: 'partial_failure',
        collections,
        failedCollection: collectionName,
        error: getErrorDetails(error),
      }
    }
  }

  return {
    ok: true,
    status: 'cleared',
    totalRemoved: collections.reduce((total, item) => total + item.removed, 0),
    collections,
  }
}

exports.main = main
