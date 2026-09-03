const assert = require('assert')
const fs = require('fs')
const Module = require('module')

class MockDatabase {
  constructor(seed = {}) {
    this.collections = {
      user_configs: [],
      user_query_state: [],
      meters: [],
      meter_check_jobs: [],
      power_records: [],
      notification_records: [],
      ...seed,
    }
    this.nextId = 1
    this.now = new Date('2026-09-01T00:00:00.000Z')
  }

  serverDate() {
    return new Date(this.now)
  }

  collection(name) {
    const database = this

    return {
      where(query) {
        return {
          async get() {
            if (database.missingCollections && database.missingCollections.has(name)) {
              throw new Error(`DATABASE_COLLECTION_NOT_EXIST: ${name}`)
            }

            const documents = database.collections[name] || []
            return {
              data: documents.filter((document) => Object.entries(query).every(
                ([key, value]) => document[key] === value,
              )),
            }
          },
        }
      },

      doc(id) {
        return {
          async update({ data }) {
            const document = (database.collections[name] || []).find((item) => item._id === id)
            assert(document, `document ${id} not found in ${name}`)
            Object.assign(document, data)
            return { stats: { updated: 1 } }
          },

          async remove() {
            const documents = database.collections[name] || []
            const index = documents.findIndex((item) => item._id === id)
            if (index >= 0) {
              documents.splice(index, 1)
            }
            return { stats: { removed: index >= 0 ? 1 : 0 } }
          },
        }
      },

      async add({ data }) {
        const document = {
          ...data,
          _id: `doc-${database.nextId++}`,
        }
        database.collections[name].push(document)
        return { _id: document._id }
      },
    }
  }
}

function loadUnbindConfig(database, context) {
  const originalLoad = Module._load
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => database,
    getWXContext: () => context,
  }
  const modulePath = require.resolve('../cloudfunctions/unbindConfig/index.js')
  delete require.cache[modulePath]

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloud
    }

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

function document(data, id) {
  return { _id: id, ...data }
}

function meter(meterId, type) {
  return document({
    meterId,
    type,
    failCount: 0,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  }, `meter-${meterId}`)
}

function config(openid, lightMeterId, acMeterId) {
  return document({
    openid,
    lightMeterId,
    acMeterId,
    email: `${openid}@example.com`,
  }, `config-${openid}`)
}

function job(meterId, status, id) {
  return document({
    meterId,
    type: 'light',
    status,
    runId: `run-${id}`,
    plannedAt: new Date('2026-09-01T00:00:00.000Z'),
    deadlineAt: new Date('2026-09-01T01:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  }, id)
}

function makeDatabase({ configs = [], meters = [], jobs = [] } = {}) {
  return new MockDatabase({
    user_configs: configs,
    user_query_state: [document({
      openid: 'openid-current',
      lastManualLightQueryAt: new Date('2026-09-01T00:00:00.000Z'),
      manualLightQueryLockUntil: new Date('2026-09-01T00:00:00.000Z'),
      lastManualAcQueryAt: new Date('2026-09-01T00:00:00.000Z'),
      manualAcQueryLockUntil: new Date('2026-09-01T00:00:00.000Z'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    }, 'query-state-current')],
    meters,
    meter_check_jobs: jobs,
    power_records: [document({ openid: 'openid-current', meterId: 'LIGHT-001' }, 'power-history')],
    notification_records: [document({ openid: 'openid-current', meterId: 'LIGHT-001' }, 'notification-history')],
  })
}

async function runUnbind(database, openid = 'openid-current') {
  const functionModule = loadUnbindConfig(database, { OPENID: openid })
  return functionModule.main({ openid: 'must-be-ignored' })
}

async function testUnbindsUnsharedMetersAndKeepsHistory() {
  const database = makeDatabase({
    configs: [config('openid-current', 'LIGHT-001', 'AC-001')],
    meters: [meter('LIGHT-001', 'light'), meter('AC-001', 'ac')],
  })
  const result = await runUnbind(database)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.status, 'unbound')
  assert.deepStrictEqual(database.collections.user_configs, [])
  assert.deepStrictEqual(database.collections.user_query_state, [])
  assert.deepStrictEqual(database.collections.meters, [])
  assert.strictEqual(database.collections.power_records.length, 1)
  assert.strictEqual(database.collections.notification_records.length, 1)
}

async function testRetainsSharedLightMeter() {
  const database = makeDatabase({
    configs: [
      config('openid-current', 'LIGHT-001', 'AC-001'),
      config('openid-other', 'LIGHT-001', 'AC-002'),
    ],
    meters: [meter('LIGHT-001', 'light'), meter('AC-001', 'ac')],
  })
  const result = await runUnbind(database)

  assert.deepStrictEqual(result.retainedMeters, ['LIGHT-001'])
  assert(!database.collections.meters.some((item) => item.meterId === 'AC-001'))
  assert(database.collections.meters.some((item) => item.meterId === 'LIGHT-001'))
  assert.strictEqual(database.collections.user_configs.length, 1)
}

async function testRetainsSharedAcMeter() {
  const database = makeDatabase({
    configs: [
      config('openid-current', 'LIGHT-001', 'AC-001'),
      config('openid-other', 'LIGHT-002', 'AC-001'),
    ],
    meters: [meter('LIGHT-001', 'light'), meter('AC-001', 'ac')],
  })
  const result = await runUnbind(database)

  assert.deepStrictEqual(result.retainedMeters, ['AC-001'])
  assert(!database.collections.meters.some((item) => item.meterId === 'LIGHT-001'))
  assert(database.collections.meters.some((item) => item.meterId === 'AC-001'))
}

async function testRetainsBothSharedMeters() {
  const database = makeDatabase({
    configs: [
      config('openid-current', 'LIGHT-001', 'AC-001'),
      config('openid-other', 'LIGHT-001', 'AC-001'),
    ],
    meters: [meter('LIGHT-001', 'light'), meter('AC-001', 'ac')],
  })
  const result = await runUnbind(database)

  assert.deepStrictEqual(result.retainedMeters.sort(), ['AC-001', 'LIGHT-001'])
  assert.strictEqual(database.collections.meters.length, 2)
}

async function testRepeatedUnbindIsIdempotent() {
  const database = makeDatabase()
  const first = await runUnbind(database)
  const second = await runUnbind(database)

  assert.strictEqual(first.ok, true)
  assert.deepStrictEqual(second, {
    ok: true,
    status: 'already_unbound',
    cleanedMeters: [],
    retainedMeters: [],
    cleanupPendingMeters: [],
    expiredJobs: 0,
  })
}

async function testMissingMeterIsAlreadyCleaned() {
  const database = makeDatabase({
    configs: [config('openid-current', 'MISSING-LIGHT', 'MISSING-AC')],
  })
  const result = await runUnbind(database)

  assert.deepStrictEqual(result.cleanedMeters.sort(), ['MISSING-AC', 'MISSING-LIGHT'])
  assert.deepStrictEqual(database.collections.user_configs, [])
}

async function testPendingJobsExpireBeforeMeterRemoval() {
  const database = makeDatabase({
    configs: [config('openid-current', 'LIGHT-001', 'AC-001')],
    meters: [meter('LIGHT-001', 'light'), meter('AC-001', 'ac')],
    jobs: [job('LIGHT-001', 'pending', 'pending-light')],
  })
  const result = await runUnbind(database)
  const expired = database.collections.meter_check_jobs[0]

  assert.strictEqual(result.expiredJobs, 1)
  assert.strictEqual(expired.status, 'expired')
  assert.strictEqual(expired.error, '电表已解绑')
  assert.strictEqual(database.collections.meters.length, 0)
}

async function testRunningJobsKeepMeterAndStopFuturePlanning() {
  const database = makeDatabase({
    configs: [config('openid-current', 'LIGHT-001', 'AC-001')],
    meters: [meter('LIGHT-001', 'light'), meter('AC-001', 'ac')],
    jobs: [
      job('LIGHT-001', 'pending', 'pending-light'),
      job('LIGHT-001', 'running', 'running-light'),
    ],
  })
  const result = await runUnbind(database)
  const lightMeter = database.collections.meters.find((item) => item.meterId === 'LIGHT-001')
  const planner = require('../cloudfunctions/shared/scheduledPlanner')

  assert.deepStrictEqual(result.cleanupPendingMeters, ['LIGHT-001'])
  assert(lightMeter)
  assert.strictEqual(lightMeter.cleanupPending, true)
  assert.strictEqual(lightMeter.cleanupReason, '电表已解绑，存在运行中的调度任务')
  assert.strictEqual(database.collections.meter_check_jobs.find((item) => item._id === 'pending-light').status, 'expired')
  assert.deepStrictEqual(
    planner.selectMetersToPlan([lightMeter], new Map()),
    [],
  )
  assert(!database.collections.meters.some((item) => item.meterId === 'AC-001'))
}

function testFrontendFlow() {
  const pagePath = require('path').join(__dirname, '..', 'miniprogram', 'pages', 'index')
  const pageSource = fs.readFileSync(`${pagePath}/index.ts`, 'utf8')
  const template = fs.readFileSync(`${pagePath}/index.wxml`, 'utf8')

  assert(template.includes('解绑并退出登录'))
  assert(template.includes('bindtap="onUnbindAndLogout"'))
  assert(template.includes('体验完整服务后再决定是否登录'))
  assert(template.includes('bindtap="onAuthorizeLogin"'))
  assert(pageSource.includes('解绑后将删除当前电表和邮箱配置，关闭低电量提醒，并退出当前账号。历史查询记录和提醒记录会保留。确定继续吗？'))
  assert(pageSource.includes('if (!confirmed)'))
  assert(/wx\.reLaunch\(\{\s*url: '\/pages\/index\/index'/.test(pageSource))
  assert(!/if \(!hasAuthenticated\(\)[\s\S]*?wx\.redirectTo\(\{\s*url: '\/pages\/login\/login'/.test(pageSource))
  assert(pageSource.includes('保存配置和查询电量需要登录，请先授权登录。'))
  assert(pageSource.includes('clearAuthenticated()'))
}

async function main() {
  await testUnbindsUnsharedMetersAndKeepsHistory()
  await testRetainsSharedLightMeter()
  await testRetainsSharedAcMeter()
  await testRetainsBothSharedMeters()
  await testRepeatedUnbindIsIdempotent()
  await testMissingMeterIsAlreadyCleaned()
  await testPendingJobsExpireBeforeMeterRemoval()
  await testRunningJobsKeepMeterAndStopFuturePlanning()
  testFrontendFlow()
  console.log('OK: unbind config tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
