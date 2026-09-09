// queryPower 云函数：校验绑定关系、执行手动查询限流、请求学校页面并记录结果。
const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  userQueryState: 'user_query_state',
  meters: 'meters',
  powerRecords: 'power_records',
}

const DEFAULT_POWER_BASE_URL = 'https://shsd.buaa.edu.cn/PubBuaa'
const XYL_AC_POWER_BASE_URL = 'https://xylktsd.buaa.edu.cn/PubBuaa'
const REQUEST_TIMEOUT_MS = 3000
const DEFAULT_CHECK_INTERVAL_MINUTES = 10
const DEFAULT_ESTIMATED_DAILY_USAGE_KWH = 5
const MANUAL_QUERY_INTERVAL_MS = 20 * 1000
const MANUAL_QUERY_LOCK_MS = 30 * 1000
const MANUAL_QUERY_TOO_FREQUENT_MESSAGE = '操作过于频繁，请稍后再试'
const MANUAL_QUERY_INITIAL_STATE = {
  // Date(0) 表示很早以前，首次查询可以立即通过时间条件。
  lastManualLightQueryAt: new Date(0),
  manualLightQueryLockUntil: new Date(0),
  lastManualAcQueryAt: new Date(0),
  manualAcQueryLockUntil: new Date(0),
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function stripTags(value) {
  // 删除 HTML 标签和常见空格实体，给后续数字/文字解析准备纯文本。
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function decodeHtml(value) {
  // 处理页面中的数字实体和 XML/HTML 实体，例如 &amp; 和 &#39;。
  return stripTags(value)
    .replace(/&#x([0-9a-f]+);/gi, (_entity, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_entity, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function parseNumber(text) {
  // 从文本中提取第一个整数或小数；解析不到时返回 undefined。
  const cleaned = decodeHtml(text).replace(/,/g, '')
  const match = cleaned.match(/-?\d+(?:\.\d+)?/)

  if (!match) {
    return undefined
  }

  const value = Number(match[0])
  return Number.isFinite(value) ? value : undefined
}

function parseRemainingKwh(html) {
  // 上游页面有两种已知电量 DOM 结构，按优先级依次尝试。
  const patterns = [
    /<use[^>]+xlink:href=["']#widget-headRemain["'][^>]*>.*?<tspan[^>]*>(.*?)<\/tspan>/is,
    /<svg[^>]+id=["']canvas1["'][^>]*>.*?<tspan[^>]*>(.*?)<\/tspan>/is,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const value = parseNumber(match[1])
      if (value !== undefined) {
        return value
      }
    }
  }

  return undefined
}

function parseCutoffTime(html) {
  // 页面把时间放在方括号中，这里只接受看起来像日期或时刻的内容。
  const matches = html.matchAll(/\[([^\]]+)\]/g)

  for (const match of matches) {
    const value = decodeHtml(match[1])

    if (/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}:\d{2}/.test(value)) {
      return value
    }
  }

  return undefined
}

function parseAddress(html) {
  // 地址页面存在编码异常和多种 HTML 结构，因此准备多个兼容正则。
  const patterns = [
    /地址:\s*(.*?)<\/p>/is,
    /鍦板潃:\s*(.*?)<\/p>/is,
    /<p[^>]*font-size:\s*20px;[^>]*>(.*?)<\/p>/is,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const value = decodeHtml(match[1]).replace('哈哈', '').replace('鍝堝搱', '').trim()
      if (value) {
        return value
      }
    }
  }

  return undefined
}

function shouldUseXueyuanRoadAcSite(meterId, type) {
  // 学院路空调电表使用另一站点；通过类型和编号范围选择上游地址。
  const normalizedMeterId = String(meterId || '').trim()

  return type === 'ac' && /^\d+$/.test(normalizedMeterId) && Number(normalizedMeterId) < 10000
}

function isCollectionNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exists|Db or Table not exist|user_query_state/i.test(message)
}

function selectPowerBaseUrl(meterId, type) {
  return shouldUseXueyuanRoadAcSite(meterId, type)
    ? XYL_AC_POWER_BASE_URL
    : DEFAULT_POWER_BASE_URL
}

function fetchPowerPage(meterId, type) {
  // 使用 Node 原生 https 请求学校页面，并把响应体拼成 UTF-8 字符串。
  const url = new URL(selectPowerBaseUrl(meterId, type))
  url.searchParams.set('id', meterId)

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 BUAA power mini program',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (response) => {
      const chunks = []

      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const html = buffer.toString('utf8')

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }

        resolve(html)
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error('请求学校电量页面超时'))
    })
    request.on('error', reject)
  })
}

async function ensureCollection(db, collectionName) {
  // 某些环境不会预先创建限流集合，首次使用时尝试补建。
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

async function assertMeterBelongsToUser(db, openid, meterId, type) {
  // 防止用户查询不属于自己的电表；权限判断必须在服务端完成。
  const result = await db.collection(COLLECTIONS.userConfigs).where({ openid }).get()
  const config = result.data[0]

  if (!config) {
    throw new Error('请先保存电表配置')
  }

  const expectedMeterId = type === 'ac' ? config.acMeterId : config.lightMeterId

  if (expectedMeterId !== meterId) {
    throw new Error('电表号与当前用户配置不一致，请先保存配置')
  }

  return config
}

function getManualQueryFields(type) {
  // 照明和空调分别使用独立的时间字段，互不阻塞。
  return type === 'ac'
    ? {
      lastAt: 'lastManualAcQueryAt',
      lockUntil: 'manualAcQueryLockUntil',
    }
    : {
      lastAt: 'lastManualLightQueryAt',
      lockUntil: 'manualLightQueryLockUntil',
    }
}

async function getOrCreateManualQueryState(db, openid) {
  // 查询或创建用户限流状态；并发创建遇到唯一键时重新读取已有记录。
  const userQueryState = db.collection(COLLECTIONS.userQueryState)

  try {
    const result = await userQueryState.where({ openid }).get()
    const current = result.data[0]

    if (current && current._id) {
      return current
    }
  } catch (error) {
    if (!isCollectionNotFoundError(error)) {
      throw error
    }

    await ensureCollection(db, COLLECTIONS.userQueryState)
  }

  const now = db.serverDate()
  const data = {
    openid,
    ...MANUAL_QUERY_INITIAL_STATE,
    createdAt: now,
    updatedAt: now,
  }

  try {
    const addResult = await userQueryState.add({ data })
    return {
      _id: addResult && (addResult._id || addResult.id),
      ...data,
    }
  } catch (error) {
    if (!/E11000|DUPLICATE[_\s-]*KEY|duplicate\s+key|unique/i.test(getErrorDetails(error))) {
      throw error
    }

    const retry = await userQueryState.where({ openid }).get()
    return retry.data[0]
  }
}

async function ensureManualQueryFields(db, state, fields) {
  // 给旧用户补齐新增字段，兼容数据库中没有锁字段的历史记录。
  const _ = db.command
  const zero = new Date(0)
  const userQueryState = db.collection(COLLECTIONS.userQueryState)

  // 兼容已经存在、还没有限流字段的用户配置。
  if (!state[fields.lockUntil]) {
    await userQueryState.where({
      _id: state._id,
      [fields.lockUntil]: _.exists(false),
    }).update({
      data: {
        [fields.lockUntil]: zero,
      },
    })
  }

  if (!state[fields.lastAt]) {
    await userQueryState.where({
      _id: state._id,
      [fields.lastAt]: _.exists(false),
    }).update({
      data: {
        [fields.lastAt]: zero,
      },
    })
  }
}

async function claimManualQuery(db, config, type, now) {
  // 用带条件的 update 原子抢占查询资格：只有锁已过期且距离上次查询足够久才会更新成功。
  if (!config || !config._id) {
    return false
  }

  const _ = db.command
  const fields = getManualQueryFields(type)
  await ensureManualQueryFields(db, config, fields)

  const result = await db.collection(COLLECTIONS.userQueryState)
    .where({
      _id: config._id,
      [fields.lockUntil]: _.lte(now),
      [fields.lastAt]: _.lte(new Date(now.getTime() - MANUAL_QUERY_INTERVAL_MS)),
    })
    .update({
      data: {
        [fields.lockUntil]: new Date(now.getTime() + MANUAL_QUERY_LOCK_MS),
        updatedAt: db.serverDate(),
      },
    })

  return Boolean(result && result.stats && result.stats.updated)
}

async function releaseManualQueryLock(db, config, type, queriedAt) {
  // 无论上游查询成功还是失败，都要释放短锁并记录本次查询时间。
  if (!config || !config._id) {
    return
  }

  const fields = getManualQueryFields(type)
  const data = {
    [fields.lockUntil]: new Date(0),
    [fields.lastAt]: queriedAt,
    updatedAt: db.serverDate(),
  }

  try {
    await db.collection(COLLECTIONS.userQueryState).doc(config._id).update({ data })
  } catch (error) {
    console.error('Failed to release manual query lock', error)
  }
}

function getErrorDetails(error) {
  // 把 SDK 的多种错误形态转换成便于日志和测试断言的字符串。
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

function isDuplicateKeyError(error) {
  const details = getErrorDetails(error)
  return /E11000|DUPLICATE[_\s-]*KEY|duplicate\s+key|duplicate\s+key\s+error|duplicate.*(?:index|unique)|unique.*(?:index|constraint|key)|唯一.*(?:索引|键)|(?:索引|键).*唯一/i.test(details)
}

async function updateMeter(db, record, type) {
  // 更新电表最新查询状态；不存在时尝试创建，并处理并发创建造成的重复键。
  const now = db.serverDate()
  const meters = db.collection(COLLECTIONS.meters)
  const existing = await meters.where({ meterId: record.meterId }).get()
  const current = existing.data[0]
  const data = {
    type,
    lastQueriedAt: record.queriedAt,
    failCount: record.ok ? 0 : ((current && current.failCount) || 0) + 1,
    lastError: record.error || '',
    updatedAt: now,
  }

  if (record.remainingKwh !== undefined) {
    data.lastRemainingKwh = record.remainingKwh
  }

  if (current && current._id) {
    await meters.doc(current._id).update({ data })
    return
  }

  try {
    await meters.add({
      data: {
        meterId: record.meterId,
        createdAt: now,
        nextCheckAt: new Date(),
        checkIntervalMinutes: DEFAULT_CHECK_INTERVAL_MINUTES,
        estimatedDailyUsageKwh: DEFAULT_ESTIMATED_DAILY_USAGE_KWH,
        scheduleMode: 'normal',
        ...data,
      },
    })
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error
    }

    const concurrentResult = await meters.where({ meterId: record.meterId }).get()
    const concurrentMeter = concurrentResult.data[0]

    if (!concurrentMeter || !concurrentMeter._id) {
      throw new Error(`更新电表 ${record.meterId} 时检测到重复键，但未能读取已有记录`)
    }

    await meters.doc(concurrentMeter._id).update({
      data: {
        ...data,
        failCount: record.ok ? 0 : ((concurrentMeter.failCount || 0) + 1),
      },
    })
  }

}

exports.main = async (event) => {
  // 主流程：参数校验 -> 验证绑定 -> 原子限流 -> 查询解析 -> 写记录 -> 释放锁。
  const meterId = String(event.meterId || '').trim()
  const type = event.type
  const queriedAt = new Date()
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  if (!meterId) {
    throw new Error('电表号不能为空')
  }

  if (type !== 'light' && type !== 'ac') {
    throw new Error('电表类型不正确')
  }

  const db = cloud.database()
  const config = await assertMeterBelongsToUser(db, OPENID, meterId, type)
  const manualQueryState = await getOrCreateManualQueryState(db, OPENID)

  // claim 返回 false 表示另一个请求正在查询，或 20 秒冷却时间尚未结束。
  const claimed = await claimManualQuery(db, manualQueryState, type, queriedAt)

  if (!claimed) {
    return {
      meterId,
      ok: false,
      error: MANUAL_QUERY_TOO_FREQUENT_MESSAGE,
      queriedAt,
    }
  }

  let record

  // 解析失败也要形成失败记录，这样页面和运营看板都能区分“没有查询”和“查询失败”。
  try {
    const html = await fetchPowerPage(meterId, type)
    const remainingKwh = parseRemainingKwh(html)

    if (remainingKwh === undefined) {
      record = {
        meterId,
        ok: false,
        error: '未能解析剩余电量',
        queriedAt,
      }
    } else {
      record = {
        meterId,
        remainingKwh,
        cutoffTime: parseCutoffTime(html),
        address: parseAddress(html),
        ok: true,
        queriedAt,
      }
    }
  } catch (error) {
    record = {
      meterId,
      ok: false,
      error: error instanceof Error ? error.message : '查询失败',
      queriedAt,
    }
  }

  // 记录和更新电表放在 finally 释放锁，避免异常导致用户永久无法再次查询。
  try {
    await db.collection(COLLECTIONS.powerRecords).add({
      data: {
        ...record,
        type,
        source: 'queryPower',
      },
    })
    await updateMeter(db, record, type)
  } finally {
    await releaseManualQueryLock(db, manualQueryState, type, queriedAt)
  }

  return record
}

exports.isDuplicateKeyError = isDuplicateKeyError
exports.claimManualQuery = claimManualQuery
exports.releaseManualQueryLock = releaseManualQueryLock
exports.updateMeter = updateMeter
