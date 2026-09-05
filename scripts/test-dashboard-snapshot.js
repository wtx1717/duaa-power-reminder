const assert = require('assert')
const Module = require('module')

class MockDatabase {
  constructor(initialCollections = {}) {
    this.collections = {
      user_configs: [],
      meters: [],
      power_records: [],
      notification_records: [],
      meter_check_jobs: [],
      ops_dashboard_snapshots: [],
      ...initialCollections,
    }
  }

  collection(name) {
    const database = this

    function getItems() {
      return database.collections[name] || (database.collections[name] = [])
    }

    function createQuery(query = {}, offset = 0, limit = Number.POSITIVE_INFINITY) {
      return {
        where(nextQuery) {
          return createQuery(nextQuery, offset, limit)
        },
        skip(nextOffset) {
          return createQuery(query, nextOffset, limit)
        },
        limit(nextLimit) {
          return createQuery(query, offset, nextLimit)
        },
        async get() {
          const data = getItems()
            .filter((document) => Object.entries(query).every(([key, expected]) => document[key] === expected))
            .slice(offset, offset + limit)

          return { data }
        },
        async update({ data }) {
          let updated = 0

          for (const document of getItems()) {
            if (Object.entries(query).every(([key, expected]) => document[key] === expected)) {
              Object.assign(document, data)
              updated += 1
            }
          }

          return { stats: { updated } }
        },
      }
    }

    return {
      where(query = {}) {
        return createQuery(query)
      },
      skip(offset) {
        return createQuery({}, offset)
      },
      limit(limit) {
        return createQuery({}, 0, limit)
      },
      async get() {
        return { data: getItems().slice() }
      },
      doc(id) {
        return {
          async set({ data }) {
            const items = getItems()
            const index = items.findIndex((document) => document._id === id)
            const document = { _id: id, ...data }

            if (index >= 0) {
              items[index] = document
            } else {
              items.push(document)
            }

            return { _id: id }
          },
          async update({ data }) {
            const document = getItems().find((item) => item._id === id)
            assert(document, `document ${id} not found`)
            Object.assign(document, data)
            return { stats: { updated: 1 } }
          },
        }
      },
      async createCollection() {
        getItems()
      },
    }
  }
}

function loadSnapshotModule(database) {
  const originalLoad = Module._load
  const modulePath = require.resolve('../cloudfunctions/scheduledDashboardSnapshot/index.js')
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: 'test-openid' }),
  }

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

function makeDate(iso) {
  return new Date(iso)
}

function buildFixtureDatabase() {
  return new MockDatabase({
    user_configs: [
      { _id: 'cfg-1', openid: 'u-1' },
      { _id: 'cfg-2', openid: 'u-2' },
    ],
    meters: [
      {
        _id: 'meter-1',
        meterId: 'M-001',
        type: 'light',
        lastRemainingKwh: 40,
        estimatedDailyUsageKwh: 1.2,
        failCount: 0,
        scheduleMode: 'normal',
        lastQueriedAt: makeDate('2026-09-04T01:00:00.000Z'),
        nextCheckAt: makeDate('2026-09-04T05:00:00.000Z'),
      },
      {
        _id: 'meter-2',
        meterId: 'M-002',
        type: 'ac',
        lastRemainingKwh: 24,
        estimatedDailyUsageKwh: 2.4,
        failCount: 0,
        scheduleMode: 'normal',
        lastQueriedAt: makeDate('2026-09-04T02:00:00.000Z'),
        nextCheckAt: makeDate('2026-09-04T06:00:00.000Z'),
      },
      {
        _id: 'meter-3',
        meterId: 'M-003',
        type: 'light',
        lastRemainingKwh: 30,
        estimatedDailyUsageKwh: 1.8,
        failCount: 1,
        scheduleMode: 'near_threshold',
        lastQueriedAt: makeDate('2026-09-04T03:00:00.000Z'),
        nextCheckAt: makeDate('2026-09-04T07:00:00.000Z'),
      },
      {
        _id: 'meter-4',
        meterId: 'M-004',
        type: 'ac',
        lastRemainingKwh: 9,
        estimatedDailyUsageKwh: 3.1,
        failCount: 3,
        scheduleMode: 'normal',
        lastQueriedAt: makeDate('2026-09-04T04:00:00.000Z'),
        nextCheckAt: makeDate('2026-09-04T08:00:00.000Z'),
      },
    ],
    power_records: [
      {
        _id: 'power-1',
        meterId: 'M-001',
        type: 'light',
        ok: true,
        queriedAt: makeDate('2026-09-03T15:59:00.000Z'),
        remainingKwh: 41,
        cutoffTime: '2026-09-04 20:00:00',
        address: 'A1',
        source: 'scheduledCheck',
      },
      {
        _id: 'power-2',
        meterId: 'M-001',
        type: 'light',
        ok: true,
        queriedAt: makeDate('2026-09-04T08:00:00.000Z'),
        remainingKwh: 40,
        cutoffTime: '2026-09-04 20:00:00',
        address: 'A1',
        source: 'queryPower',
      },
      {
        _id: 'power-3',
        meterId: 'M-001',
        type: 'light',
        ok: true,
        queriedAt: makeDate('2026-09-04T10:00:00.000Z'),
        remainingKwh: 39,
        cutoffTime: '2026-09-04 21:00:00',
        address: 'A2',
        source: 'scheduledCheck',
      },
      {
        _id: 'power-4',
        meterId: 'M-003',
        type: 'light',
        ok: false,
        queriedAt: makeDate('2026-09-04T12:00:00.000Z'),
        error: 'fetch failed',
        source: 'scheduledCheck',
      },
      {
        _id: 'power-5',
        meterId: 'M-004',
        type: 'ac',
        ok: true,
        queriedAt: makeDate('2026-09-04T14:00:00.000Z'),
        remainingKwh: 9,
        cutoffTime: '2026-09-04 22:00:00',
        address: 'A4',
        source: 'scheduledCheck',
      },
      {
        _id: 'power-outside',
        meterId: 'M-002',
        type: 'ac',
        ok: true,
        queriedAt: makeDate('2026-09-03T10:00:00.000Z'),
        remainingKwh: 25,
        cutoffTime: '2026-09-03 20:00:00',
        address: 'B1',
        source: 'queryPower',
      },
    ],
    notification_records: [
      {
        _id: 'notify-1',
        openid: 'u-1',
        meterId: 'M-001',
        type: 'light',
        remainingKwh: 12,
        thresholdKwh: 20,
        sentAt: makeDate('2026-09-04T03:00:00.000Z'),
        status: 'sent',
        source: 'scheduledCheck',
        email: 'u1@example.com',
      },
      {
        _id: 'notify-2',
        openid: 'u-1',
        meterId: 'M-004',
        type: 'ac',
        remainingKwh: 9,
        thresholdKwh: 20,
        sentAt: makeDate('2026-09-04T05:00:00.000Z'),
        status: 'failed',
        source: 'queryPower',
        error: 'smtp failed',
      },
      {
        _id: 'notify-outside',
        openid: 'u-2',
        meterId: 'M-002',
        type: 'ac',
        remainingKwh: 15,
        thresholdKwh: 20,
        sentAt: makeDate('2026-09-03T05:00:00.000Z'),
        status: 'sent',
        source: 'scheduledCheck',
      },
    ],
    meter_check_jobs: [
      {
        _id: 'job-1',
        meterId: 'M-001',
        type: 'light',
        status: 'done',
        runId: 'run-1',
        plannedAt: makeDate('2026-09-04T01:00:00.000Z'),
        startedAt: makeDate('2026-09-04T01:05:00.000Z'),
        finishedAt: makeDate('2026-09-04T01:10:00.000Z'),
        attempts: 1,
        createdAt: makeDate('2026-09-04T00:50:00.000Z'),
      },
      {
        _id: 'job-2',
        meterId: 'M-002',
        type: 'ac',
        status: 'running',
        runId: 'run-2',
        plannedAt: makeDate('2026-09-04T02:00:00.000Z'),
        startedAt: makeDate('2026-09-04T02:05:00.000Z'),
        attempts: 2,
        createdAt: makeDate('2026-09-04T01:55:00.000Z'),
      },
      {
        _id: 'job-3',
        meterId: 'M-003',
        type: 'light',
        status: 'failed',
        runId: 'run-3',
        plannedAt: makeDate('2026-09-04T03:00:00.000Z'),
        startedAt: makeDate('2026-09-04T03:05:00.000Z'),
        finishedAt: makeDate('2026-09-04T03:15:00.000Z'),
        attempts: 3,
        error: 'timeout',
        createdAt: makeDate('2026-09-04T02:50:00.000Z'),
      },
      {
        _id: 'job-4',
        meterId: 'M-004',
        type: 'ac',
        status: 'expired',
        runId: 'run-4',
        plannedAt: makeDate('2026-09-04T04:00:00.000Z'),
        attempts: 0,
        createdAt: makeDate('2026-09-04T03:50:00.000Z'),
      },
      {
        _id: 'job-outside',
        meterId: 'M-001',
        type: 'light',
        status: 'done',
        runId: 'run-0',
        plannedAt: makeDate('2026-09-03T04:00:00.000Z'),
        createdAt: makeDate('2026-09-03T03:50:00.000Z'),
      },
    ],
  })
}

async function testBuildSnapshot() {
  const database = buildFixtureDatabase()
  const { buildSnapshot } = loadSnapshotModule(database)
  const snapshot = await buildSnapshot(database, '2026-09-04', new Date('2026-09-04T15:00:00.000Z'))

  assert.strictEqual(snapshot.snapshotDate, '2026-09-04')
  assert.strictEqual(snapshot.status, 'success')
  assert.deepStrictEqual(snapshot.sourceWindow, {
    startAt: '2026-09-03T16:00:00.000Z',
    endAt: '2026-09-04T16:00:00.000Z',
  })
  assert.strictEqual(snapshot.userCount, 2)
  assert.strictEqual(snapshot.meterCount, 4)
  assert.strictEqual(snapshot.powerRecordCount, 4)
  assert.strictEqual(snapshot.notificationRecordCount, 2)
  assert.strictEqual(snapshot.jobRecordCount, 4)
  assert.strictEqual(snapshot.completedJobCount, 1)
  assert.strictEqual(snapshot.failedJobCount, 2)
  assert.strictEqual(snapshot.completionRate, 25)
  assert.deepStrictEqual(snapshot.stateCounts, {
    normal: 1,
    warn: 1,
    monitor: 1,
    error: 1,
  })

  const meter1 = snapshot.meters.find((item) => item.meterId === 'M-001')
  const meter4 = snapshot.meters.find((item) => item.meterId === 'M-004')

  assert(meter1, 'meter M-001 should exist in snapshot')
  assert.strictEqual(meter1.queryCount, 2)
  assert.strictEqual(meter1.notifyCount, 1)
  assert.strictEqual(meter1.latestAddress, 'A2')
  assert.strictEqual(meter1.state, 'normal')
  assert(meter4, 'meter M-004 should exist in snapshot')
  assert.strictEqual(meter4.state, 'error')

  assert.strictEqual(snapshot.kpis[0].value, '2')
  assert.strictEqual(snapshot.kpis[1].value, '4')
  assert.strictEqual(snapshot.kpis[2].value, '4')
  assert.strictEqual(snapshot.kpis[3].value, '4')
  assert.strictEqual(snapshot.kpis[4].value, '25%')
  assert.strictEqual(snapshot.kpis[5].value, '2')
  assert.strictEqual(snapshot.kpis[6].value, '1')
}

async function testUpsertSnapshot() {
  const database = buildFixtureDatabase()
  const { buildSnapshot, upsertSnapshot } = loadSnapshotModule(database)
  const snapshot = await buildSnapshot(database, '2026-09-04', new Date('2026-09-04T15:00:00.000Z'))

  database.collections.ops_dashboard_snapshots = [
    {
      _id: 'snapshot-2026-09-04',
      snapshotDate: '2026-09-04',
      generatedAt: 'old-value',
      staleField: true,
    },
  ]

  const replaced = await upsertSnapshot(database, snapshot)
  assert.strictEqual(replaced, true)
  assert.strictEqual(database.collections.ops_dashboard_snapshots.length, 1)
  assert.strictEqual(database.collections.ops_dashboard_snapshots[0]._id, 'snapshot-2026-09-04')
  assert.strictEqual(database.collections.ops_dashboard_snapshots[0].generatedAt, snapshot.generatedAt)
  assert.strictEqual(database.collections.ops_dashboard_snapshots[0].staleField, undefined)

  const emptyDatabase = buildFixtureDatabase()
  emptyDatabase.collections.ops_dashboard_snapshots = []
  const inserted = await upsertSnapshot(emptyDatabase, snapshot)

  assert.strictEqual(inserted, false)
  assert.strictEqual(emptyDatabase.collections.ops_dashboard_snapshots.length, 1)
  assert.strictEqual(emptyDatabase.collections.ops_dashboard_snapshots[0]._id, '2026-09-04')
}

async function main() {
  await testBuildSnapshot()
  await testUpsertSnapshot()
  console.log('OK: dashboard snapshot cloud function tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
