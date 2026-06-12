const cloud = require('wx-server-sdk')
const https = require('https')
const { URL } = require('url')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
  powerRecords: 'power_records',
}

const POWER_BASE_URL = 'https://shsd.buaa.edu.cn/PubBuaa'
const REQUEST_TIMEOUT_MS = 15000

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function stripTags(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function decodeHtml(value) {
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
  const cleaned = decodeHtml(text).replace(/,/g, '')
  const match = cleaned.match(/-?\d+(?:\.\d+)?/)

  if (!match) {
    return undefined
  }

  const value = Number(match[0])
  return Number.isFinite(value) ? value : undefined
}

function parseRemainingKwh(html) {
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

function fetchPowerPage(meterId) {
  const url = new URL(POWER_BASE_URL)
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

async function assertMeterBelongsToUser(db, openid, meterId, type) {
  const result = await db.collection(COLLECTIONS.userConfigs).where({ openid }).get()
  const config = result.data[0]

  if (!config) {
    throw new Error('请先保存电表配置')
  }

  const expectedMeterId = type === 'ac' ? config.acMeterId : config.lightMeterId

  if (expectedMeterId !== meterId) {
    throw new Error('电表号与当前用户配置不一致，请先保存配置')
  }
}

async function updateMeter(db, record, type) {
  const now = db.serverDate()
  const meters = db.collection(COLLECTIONS.meters)
  const existing = await meters.where({ meterId: record.meterId }).get()
  const current = existing.data[0]
  const data = {
    type,
    lastRemainingKwh: record.remainingKwh,
    lastQueriedAt: record.queriedAt,
    nextCheckAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    failCount: record.ok ? 0 : ((current && current.failCount) || 0) + 1,
    lastError: record.error || '',
    updatedAt: now,
  }

  if (current && current._id) {
    await meters.doc(current._id).update({ data })
    return
  }

  await meters.add({
    data: {
      meterId: record.meterId,
      createdAt: now,
      ...data,
    },
  })
}

exports.main = async (event) => {
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
  await assertMeterBelongsToUser(db, OPENID, meterId, type)

  let record

  try {
    const html = await fetchPowerPage(meterId)
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

  await db.collection(COLLECTIONS.powerRecords).add({
    data: record,
  })
  await updateMeter(db, record, type)

  return record
}
