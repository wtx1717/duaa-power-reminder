const assert = require('assert')
const EventEmitter = require('events')
const Module = require('module')

const SUCCESS_HTML = '<svg id="canvas1"><tspan>15.5</tspan></svg>[2026-09-02 10:00]'
const TOO_FREQUENT_MESSAGE = '操作过于频繁，请稍后再试'

class MockDatabase {
  constructor() {
    this.collections = {
      user_configs: [{
        _id: 'config-1',
        openid: 'openid-user-1',
        lightMeterId: 'LIGHT-001',
        acMeterId: 'AC-001',
        email: 'user@example.com',
      }],
      user_query_state: [],
      meters: [],
      power_records: [],
    }
    this.nextId = 1
    this.now = new Date('2026-09-02T00:00:00.000Z')
    this.command = {
      lte(value) {
        return { type: 'lte', value }
      },
      exists(value) {
        return { type: 'exists', value }
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
            return {
              data: (database.collections[name] || []).filter((document) => matchesQuery(document, query)),
            }
          },
          async update({ data }) {
            let updated = 0

            for (const document of database.collections[name] || []) {
              if (matchesQuery(document, query)) {
                Object.assign(document, data)
                updated += 1
              }
            }

            return { stats: { updated } }
          },
        }
      },
      async add({ data }) {
        const document = {
          ...data,
          _id: `doc-${database.nextId++}`,
        }
        const documents = database.collections[name] || (database.collections[name] = [])
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

function matchesQuery(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && expected.type === 'lte') {
      return document[key] instanceof Date && document[key].getTime() <= expected.value.getTime()
    }

    if (expected && typeof expected === 'object' && expected.type === 'exists') {
      return Object.prototype.hasOwnProperty.call(document, key) === expected.value
    }

    return document[key] === expected
  })
}

function createHttpsMock(state) {
  return {
    get(_url, _options, callback) {
      state.fetchCount += 1
      const request = new EventEmitter()

      request.destroy = (error) => {
        process.nextTick(() => request.emit('error', error))
      }

      setTimeout(() => {
        const response = new EventEmitter()
        response.statusCode = 200
        callback(response)
        process.nextTick(() => {
          response.emit('data', Buffer.from(SUCCESS_HTML))
          response.emit('end')
        })
      }, state.delayMs)

      return request
    },
  }
}

function loadQueryPower(database, state) {
  const originalLoad = Module._load
  const modulePath = require.resolve('../cloudfunctions/queryPower/index.js')
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: 'openid-user-1' }),
  }

  delete require.cache[modulePath]
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloud
    }

    if (request === 'https') {
      return createHttpsMock(state)
    }

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

function resetManualQueryState(database, openid = 'openid-user-1') {
  const state = database.collections.user_query_state[0] || {
    _id: 'query-state-1',
    openid,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  }

  state.lastManualLightQueryAt = new Date(0)
  state.manualLightQueryLockUntil = new Date(0)
  state.lastManualAcQueryAt = new Date(0)
  state.manualAcQueryLockUntil = new Date(0)

  if (!database.collections.user_query_state.length) {
    database.collections.user_query_state.push(state)
  }
}

function getManualQueryState(database) {
  return database.collections.user_query_state[0]
}

async function testSingleQueryAndCooldown() {
  const database = new MockDatabase()
  const state = { fetchCount: 0, delayMs: 0 }
  const queryPower = loadQueryPower(database, state)

  const first = await queryPower.main({ meterId: 'LIGHT-001', type: 'light' })
  assert.strictEqual(first.ok, true, 'single query should pass')
  assert.strictEqual(state.fetchCount, 1, 'single query should fetch power page once')
  assert.strictEqual(database.collections.power_records.length, 1, 'successful query should be recorded')

  const second = await queryPower.main({ meterId: 'LIGHT-001', type: 'light' })
  assert.strictEqual(second.ok, false, 'quick repeat should be blocked')
  assert.strictEqual(second.error, TOO_FREQUENT_MESSAGE)
  assert.strictEqual(state.fetchCount, 1, 'blocked repeat should not fetch power page')
  assert.strictEqual(database.collections.power_records.length, 1, 'blocked repeat should not be recorded as power query')
}

async function testConcurrentDuplicateQuery() {
  const database = new MockDatabase()
  const state = { fetchCount: 0, delayMs: 30 }
  const queryPower = loadQueryPower(database, state)

  resetManualQueryState(database)

  const results = await Promise.all([
    queryPower.main({ meterId: 'LIGHT-001', type: 'light' }),
    queryPower.main({ meterId: 'LIGHT-001', type: 'light' }),
  ])

  assert.strictEqual(results.filter((result) => result.ok).length, 1, 'only one concurrent duplicate should pass')
  assert.strictEqual(results.filter((result) => result.error === TOO_FREQUENT_MESSAGE).length, 1)
  assert.strictEqual(state.fetchCount, 1, 'concurrent duplicate should fetch power page once')
  assert(getManualQueryState(database), 'manual query state should be created')
  assert.strictEqual(database.collections.user_configs[0].lastManualLightQueryAt, undefined)
}

async function testLightAndAcSameClick() {
  const database = new MockDatabase()
  const state = { fetchCount: 0, delayMs: 0 }
  const queryPower = loadQueryPower(database, state)

  resetManualQueryState(database)

  const [lightResult, acResult] = await Promise.all([
    queryPower.main({ meterId: 'LIGHT-001', type: 'light' }),
    queryPower.main({ meterId: 'AC-001', type: 'ac' }),
  ])

  assert.strictEqual(lightResult.ok, true, 'light query should pass')
  assert.strictEqual(acResult.ok, true, 'ac query should pass')
  assert.strictEqual(state.fetchCount, 2, 'one normal button click should still query both meters')
  assert(getManualQueryState(database), 'manual query state should be created')
}

async function main() {
  await testSingleQueryAndCooldown()
  await testConcurrentDuplicateQuery()
  await testLightAndAcSameClick()
  console.log('OK: queryPower rate limit tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
