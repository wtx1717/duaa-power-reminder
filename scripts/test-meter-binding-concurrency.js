const assert = require('assert')
const Module = require('module')

const DUPLICATE_KEY_ERROR = 'E11000 duplicate key error collection: meters index: meterId_1'

class MockDatabase {
  constructor() {
    this.collections = {
      meters: [],
      user_configs: [],
      meter_check_jobs: [],
    }
    this.nextId = 1
    this.now = new Date('2026-09-01T00:00:00.000Z')
    this.enforceMeterUniqueIndex = true
    this.hideMetersUntilDuplicateAdd = false
    this.command = {
      remove() {
        return { __op: 'remove' }
      },
    }
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
            const documents = database.collections[name] || []
            const shouldHideMeters = name === 'meters'
              && database.hideMetersUntilDuplicateAdd
            const data = shouldHideMeters
              ? []
              : documents.filter((document) => Object.entries(query).every(
                ([key, value]) => document[key] === value,
              ))

            return { data }
          },
        }
      },

      async add({ data }) {
        const documents = database.collections[name] || (database.collections[name] = [])
        const duplicate = name === 'meters'
          && database.enforceMeterUniqueIndex
          && documents.some((document) => document.meterId === data.meterId)

        if (duplicate) {
          database.hideMetersUntilDuplicateAdd = false
          throw new Error(DUPLICATE_KEY_ERROR)
        }

        const document = {
          ...data,
          _id: `doc-${database.nextId++}`,
        }
        documents.push(document)
        return { _id: document._id }
      },

      doc(id) {
        return {
          async update({ data }) {
            const document = (database.collections[name] || []).find((item) => item._id === id)
            assert(document, `document ${id} not found`)
            applyUpdate(document, data)
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
    }
  }
}

function applyUpdate(document, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && value.__op === 'remove') {
      delete document[key]
    } else {
      document[key] = value
    }
  }
}

function loadCloudFunctions(database, context) {
  const originalLoad = Module._load
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => database,
    getWXContext: () => context,
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloud
    }

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    delete require.cache[require.resolve('../cloudfunctions/saveConfig/index.js')]
    delete require.cache[require.resolve('../cloudfunctions/queryPower/index.js')]
    return {
      saveConfig: require('../cloudfunctions/saveConfig/index.js'),
      queryPower: require('../cloudfunctions/queryPower/index.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

async function testSaveConfigConcurrency() {
  const database = new MockDatabase()
  const context = { OPENID: 'openid-user-1' }
  const { saveConfig } = loadCloudFunctions(database, context)
  const input = {
    lightMeterId: 'LIGHT-001',
    acMeterId: 'AC-001',
    email: 'USER@example.com',
    reminderEnabled: true,
  }

  await saveConfig.main(input)

  assert.strictEqual(database.collections.meters.length, 2, 'first bind should create two meters')
  assert.strictEqual(database.collections.user_configs.length, 1, 'first bind should create one user config')
  const lightMeter = database.collections.meters.find((meter) => meter.meterId === input.lightMeterId)
  assert(lightMeter.nextCheckAt instanceof Date, 'new meter should initialize nextCheckAt')
  const initialNextCheckAt = lightMeter.nextCheckAt

  await saveConfig.main({
    ...input,
    email: 'UPDATED@example.com',
  })
  assert.strictEqual(database.collections.user_configs.length, 1, 'same user should update one config')
  assert.strictEqual(database.collections.user_configs[0].email, 'updated@example.com')
  assert(!Object.prototype.hasOwnProperty.call(database.collections.user_configs[0], 'subscribeStatus'))
  assert(!Object.prototype.hasOwnProperty.call(database.collections.user_configs[0], 'thresholdKwh'))

  lightMeter.lastQueriedAt = new Date('2026-09-01T01:00:00.000Z')
  lightMeter.lastRemainingKwh = 12
  lightMeter.failCount = 4
  lightMeter.lastError = 'previous error'
  lightMeter.lowPowerNotifiedAt = new Date('2026-09-01T00:30:00.000Z')
  lightMeter.lastRechargeDetectedAt = new Date('2026-09-01T00:45:00.000Z')
  context.OPENID = 'openid-user-2'

  await saveConfig.main({
    ...input,
    email: 'SECOND@example.com',
  })

  assert.strictEqual(database.collections.meters.length, 2, 'duplicate bind must not create meters')
  assert.strictEqual(database.collections.user_configs.length, 2, 'different users need separate configs')
  assert.strictEqual(lightMeter.nextCheckAt, initialNextCheckAt, 'existing meter nextCheckAt must be preserved')
  assert.strictEqual(lightMeter.lastRemainingKwh, 12, 'existing runtime fields must be preserved')
  assert.strictEqual(lightMeter.failCount, 4, 'existing failCount must be preserved')
  assert.strictEqual(lightMeter.lastError, 'previous error', 'existing lastError must be preserved')
  assert.strictEqual(database.collections.user_configs[1].email, 'second@example.com')
}

async function testSaveConfigRemovesLegacyFields() {
  const database = new MockDatabase()
  const context = { OPENID: 'openid-user-1' }
  const { saveConfig } = loadCloudFunctions(database, context)
  database.collections.user_configs.push({
    _id: 'config-legacy',
    openid: 'openid-user-1',
    lightMeterId: 'OLD-LIGHT',
    acMeterId: 'OLD-AC',
    email: 'old@example.com',
    reminderEnabled: true,
    subscribeStatus: 'accepted',
    thresholdKwh: 20,
    lastManualLightQueryAt: new Date(),
    manualLightQueryLockUntil: new Date(),
    lastManualAcQueryAt: new Date(),
    manualAcQueryLockUntil: new Date(),
  })

  await saveConfig.main({
    lightMeterId: 'LIGHT-001',
    acMeterId: 'AC-001',
    email: 'new@example.com',
    reminderEnabled: true,
  })

  const config = database.collections.user_configs[0]
  assert.strictEqual(config.lightMeterId, 'LIGHT-001')
  assert.strictEqual(config.acMeterId, 'AC-001')
  for (const field of [
    'subscribeStatus',
    'thresholdKwh',
    'lastManualLightQueryAt',
    'manualLightQueryLockUntil',
    'lastManualAcQueryAt',
    'manualAcQueryLockUntil',
  ]) {
    assert(!Object.prototype.hasOwnProperty.call(config, field), `${field} should be removed`)
  }
}

async function testSaveConfigRemovesReplacedMeters() {
  const database = new MockDatabase()
  const context = { OPENID: 'openid-user-1' }
  const { saveConfig } = loadCloudFunctions(database, context)

  database.collections.user_configs.push({
    _id: 'config-current',
    openid: 'openid-user-1',
    lightMeterId: 'OLD-LIGHT',
    acMeterId: 'OLD-AC',
    email: 'old@example.com',
    reminderEnabled: true,
  })
  database.collections.meters.push(
    {
      _id: 'meter-old-light',
      meterId: 'OLD-LIGHT',
      type: 'light',
      failCount: 0,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    {
      _id: 'meter-old-ac',
      meterId: 'OLD-AC',
      type: 'ac',
      failCount: 0,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  )

  await saveConfig.main({
    lightMeterId: 'NEW-LIGHT',
    acMeterId: 'NEW-AC',
    email: 'new@example.com',
    reminderEnabled: true,
  })

  assert(!database.collections.meters.some((item) => item.meterId === 'OLD-LIGHT'))
  assert(!database.collections.meters.some((item) => item.meterId === 'OLD-AC'))
  assert(database.collections.meters.some((item) => item.meterId === 'NEW-LIGHT'))
  assert(database.collections.meters.some((item) => item.meterId === 'NEW-AC'))
}

async function testSaveConfigRetainsSharedOldMeter() {
  const database = new MockDatabase()
  const context = { OPENID: 'openid-user-1' }
  const { saveConfig } = loadCloudFunctions(database, context)

  database.collections.user_configs.push(
    {
      _id: 'config-current',
      openid: 'openid-user-1',
      lightMeterId: 'OLD-LIGHT',
      acMeterId: 'OLD-AC',
      email: 'old@example.com',
      reminderEnabled: true,
    },
    {
      _id: 'config-other',
      openid: 'openid-user-2',
      lightMeterId: 'OLD-LIGHT',
      acMeterId: 'OTHER-AC',
      email: 'other@example.com',
      reminderEnabled: true,
    },
  )
  database.collections.meters.push(
    {
      _id: 'meter-old-light',
      meterId: 'OLD-LIGHT',
      type: 'light',
      failCount: 0,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    {
      _id: 'meter-old-ac',
      meterId: 'OLD-AC',
      type: 'ac',
      failCount: 0,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  )

  await saveConfig.main({
    lightMeterId: 'NEW-LIGHT',
    acMeterId: 'NEW-AC',
    email: 'new@example.com',
    reminderEnabled: true,
  })

  assert(database.collections.meters.some((item) => item.meterId === 'OLD-LIGHT'))
  assert(!database.collections.meters.some((item) => item.meterId === 'OLD-AC'))
}

async function testSaveConfigMarksCleanupPendingForRunningOldMeterJob() {
  const database = new MockDatabase()
  const context = { OPENID: 'openid-user-1' }
  const { saveConfig } = loadCloudFunctions(database, context)

  database.collections.user_configs.push({
    _id: 'config-current',
    openid: 'openid-user-1',
    lightMeterId: 'OLD-LIGHT',
    acMeterId: 'OLD-AC',
    email: 'old@example.com',
    reminderEnabled: true,
  })
  database.collections.meters.push(
    {
      _id: 'meter-old-light',
      meterId: 'OLD-LIGHT',
      type: 'light',
      failCount: 0,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    {
      _id: 'meter-old-ac',
      meterId: 'OLD-AC',
      type: 'ac',
      failCount: 0,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  )
  database.collections.meter_check_jobs.push({
    _id: 'job-running-light',
    meterId: 'OLD-LIGHT',
    type: 'light',
    status: 'running',
    runId: 'run-1',
    plannedAt: new Date('2026-09-01T00:00:00.000Z'),
    deadlineAt: new Date('2026-09-01T01:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  })

  await saveConfig.main({
    lightMeterId: 'NEW-LIGHT',
    acMeterId: 'NEW-AC',
    email: 'new@example.com',
    reminderEnabled: true,
  })

  const meter = database.collections.meters.find((item) => item.meterId === 'OLD-LIGHT')
  assert(meter)
  assert.strictEqual(meter.cleanupPending, true)
  assert.strictEqual(meter.cleanupReason, '电表已解绑，存在运行中的调度任务')
  assert.strictEqual(database.collections.meter_check_jobs[0].status, 'running')
  assert(!database.collections.meters.some((item) => item.meterId === 'OLD-AC'))
}

async function testDuplicateKeyRecovery() {
  const database = new MockDatabase()
  const { saveConfig } = loadCloudFunctions(database, { OPENID: 'unused' })
  const meters = database.collection('meters')
  await meters.add({
    data: {
      meterId: 'CONCURRENT-001',
      type: 'light',
      failCount: 3,
      nextCheckAt: new Date('2026-09-02T00:00:00.000Z'),
      estimatedDailyUsageKwh: 8,
      scheduleMode: 'near_threshold',
      lastQueriedAt: new Date('2026-09-01T01:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T01:00:00.000Z'),
    },
  })

  await saveConfig.upsertMeter(database, 'CONCURRENT-001', 'ac')

  const meter = database.collections.meters[0]
  assert.strictEqual(meter.type, 'ac', 'duplicate-key recovery should update ordinary fields')
  assert.strictEqual(meter.nextCheckAt.toISOString(), '2026-09-02T00:00:00.000Z')
  assert.strictEqual(meter.failCount, 3)
  assert.strictEqual(meter.lastQueriedAt.toISOString(), '2026-09-01T01:00:00.000Z')
  assert.strictEqual(meter.estimatedDailyUsageKwh, 8)
  assert.strictEqual(meter.scheduleMode, 'near_threshold')
  assert(saveConfig.isDuplicateKeyError({ errCode: 'DUPLICATE_KEY', errMsg: 'unique index conflict' }))
}

async function testQueryPowerDuplicateKeyRecovery() {
  const database = new MockDatabase()
  const { queryPower } = loadCloudFunctions(database, { OPENID: 'unused' })
  const meters = database.collection('meters')
  await meters.add({
    data: {
      meterId: 'QUERY-001',
      type: 'light',
      failCount: 2,
      nextCheckAt: new Date('2026-09-03T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T01:00:00.000Z'),
    },
  })
  database.hideMetersUntilDuplicateAdd = true

  await queryPower.updateMeter(database, {
    meterId: 'QUERY-001',
    remainingKwh: 18,
    ok: true,
    queriedAt: new Date('2026-09-01T02:00:00.000Z'),
  }, 'light')

  const meter = database.collections.meters[0]
  assert.strictEqual(database.collections.meters.length, 1)
  assert.strictEqual(meter.lastRemainingKwh, 18)
  assert.strictEqual(meter.failCount, 0, 'successful query should preserve existing reset behavior')
  assert.strictEqual(meter.nextCheckAt.toISOString(), '2026-09-03T00:00:00.000Z')
}

async function main() {
  await testSaveConfigConcurrency()
  await testSaveConfigRemovesLegacyFields()
  await testSaveConfigRemovesReplacedMeters()
  await testSaveConfigRetainsSharedOldMeter()
  await testSaveConfigMarksCleanupPendingForRunningOldMeterJob()
  await testDuplicateKeyRecovery()
  await testQueryPowerDuplicateKeyRecovery()
  console.log('OK: meter binding concurrency tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
