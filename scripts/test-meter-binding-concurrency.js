const assert = require('assert')
const Module = require('module')

const DUPLICATE_KEY_ERROR = 'E11000 duplicate key error collection: meters index: meterId_1'

class MockDatabase {
  constructor() {
    this.collections = {
      meters: [],
      user_configs: [],
    }
    this.nextId = 1
    this.now = new Date('2026-09-01T00:00:00.000Z')
    this.enforceMeterUniqueIndex = true
    this.hideMetersUntilDuplicateAdd = false
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
            Object.assign(document, data)
            return { stats: { updated: 1 } }
          },
        }
      },
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
  await testDuplicateKeyRecovery()
  await testQueryPowerDuplicateKeyRecovery()
  console.log('OK: meter binding concurrency tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
