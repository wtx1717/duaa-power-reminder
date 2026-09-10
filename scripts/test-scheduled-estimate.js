// 定时日耗估算测试。
// 验证最小采样窗口、低耗电过滤、充值识别和失败查询对当前状态的影响。
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const Module = require('module')
const path = require('path')

const EXECUTOR_PATH = '../cloudfunctions/scheduledCheckDispatch/shared/scheduledExecutor.js'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

function testExecutorCopiesStayInSync() {
  const executorPaths = [
    path.join(__dirname, '..', 'cloudfunctions', 'shared', 'scheduledExecutor.js'),
    path.join(__dirname, '..', 'cloudfunctions', 'scheduledCheck', 'shared', 'scheduledExecutor.js'),
    path.join(__dirname, '..', 'cloudfunctions', 'scheduledCheckDispatch', 'shared', 'scheduledExecutor.js'),
  ]
  const hashes = executorPaths.map((executorPath) => crypto
    .createHash('sha256')
    .update(fs.readFileSync(executorPath))
    .digest('hex'))

  assert(hashes.every((hash) => hash === hashes[0]), 'scheduled executor copies must remain byte-for-byte identical')
}

function loadExecutor() {
  const originalLoad = Module._load
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
  }

  delete require.cache[require.resolve(EXECUTOR_PATH)]
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloud
    }

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    return require(EXECUTOR_PATH)
  } finally {
    Module._load = originalLoad
  }
}

function atDay(day) {
  return new Date(Date.UTC(2026, 8, 1 + day))
}

function record(day, remainingKwh, source = 'scheduledCheck') {
  return {
    meterId: 'LIGHT-001',
    remainingKwh,
    ok: true,
    queriedAt: atDay(day),
    source,
  }
}

function makeMeter(estimatedDailyUsageKwh = 5) {
  return {
    _id: 'meter-1',
    meterId: 'LIGHT-001',
    type: 'light',
    checkIntervalMinutes: 10,
    estimatedDailyUsageKwh,
    scheduleMode: 'normal',
    failCount: 0,
  }
}

function assertClose(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9, message || `${actual} should equal ${expected}`)
}

function daysBetween(left, right) {
  return (left.getTime() - right.getTime()) / ONE_DAY_MS
}

function calculate(executor, meter, current, previousRecord, estimateBaseRecord) {
  return executor.calculateScheduleState({
    meter,
    record: current,
    previousRecord,
    estimateBaseRecord,
    now: current.queriedAt,
  })
}

async function testEstimateBaseUsesFourDayWindow() {
  const executor = loadExecutor()
  const current = record(4, 16)
  const history = [
    record(3, 17),
    record(2, 18),
    record(1, 19),
    record(0, 20),
  ]

  const base = executor.findEstimateBaseRecord(history, current)
  assert.strictEqual(base.queriedAt.getTime(), atDay(0).getTime())

  const schedule = calculate(executor, makeMeter(), current, history[0], base)
  assertClose(schedule.estimatedDailyUsageKwh, 3.4)
  assert.strictEqual(schedule.dailyUsageUpdated, true)
  assert.strictEqual(schedule.isColdStart, false)
}

async function testShortWindowDoesNotUpdate() {
  const executor = loadExecutor()
  const current = record(3, 16)
  const base = record(0, 20)

  const schedule = calculate(executor, makeMeter(), current, record(2, 18), base)
  assert.strictEqual(schedule.estimatedDailyUsageKwh, 5)
  assert.strictEqual(schedule.dailyUsageUpdated, false)
  assert.strictEqual(schedule.isColdStart, true)
}

async function testLowUsageIsIgnoredButExactThresholdIsAccepted() {
  const executor = loadExecutor()
  const base = record(0, 20)

  const lowUsage = calculate(executor, makeMeter(), record(4, 16.04), record(3, 16.3), base)
  assert.strictEqual(lowUsage.estimatedDailyUsageKwh, 5)
  assert.strictEqual(lowUsage.dailyUsageUpdated, false)
  assert.strictEqual(lowUsage.isColdStart, true)

  const thresholdUsage = calculate(executor, makeMeter(), record(4, 16), record(3, 16.3), base)
  assertClose(thresholdUsage.estimatedDailyUsageKwh, 3.4)
  assert.strictEqual(thresholdUsage.dailyUsageUpdated, true)
  assert.strictEqual(thresholdUsage.isColdStart, false)
}

async function testDailyUsageFormulaBranches() {
  const executor = loadExecutor()

  // 差值小于 3 时使用原来的 0.8/0.2 平滑公式。
  const smooth = calculate(
    executor,
    makeMeter(),
    record(4, 4),
    record(3, 5),
    record(0, 20),
  )
  assertClose(smooth.estimatedDailyUsageKwh, 4.8)

  // 观测日耗高于旧估算且差值达到 3 时使用 0.4/0.6。
  const rising = calculate(
    executor,
    makeMeter(),
    record(4, 64),
    record(3, 65),
    record(0, 100),
  )
  assertClose(rising.estimatedDailyUsageKwh, 7.4)

  // 观测日耗低于旧估算且差值达到 3 时使用 0.6/0.4。
  const falling = calculate(
    executor,
    makeMeter(),
    record(4, 16),
    record(3, 16.2),
    record(0, 20),
  )
  assertClose(falling.estimatedDailyUsageKwh, 3.4)

  // 等于阈值也属于突变分支（>= 3）。
  const boundary = calculate(
    executor,
    makeMeter(),
    record(4, 8),
    record(3, 8.2),
    record(0, 40),
  )
  assertClose(boundary.estimatedDailyUsageKwh, 6.8)
}

async function testPositiveEstimateBelowLegacyFloorIsUsable() {
  const executor = loadExecutor()
  const base = record(0, 20)
  const schedule = calculate(executor, makeMeter(0.4), record(4, 16), record(3, 16.5), base)

  assertClose(schedule.estimatedDailyUsageKwh, 0.52)
  assert.strictEqual(schedule.dailyUsageUpdated, true)
  assert.strictEqual(schedule.isColdStart, false)
}

async function testRechargeDoesNotContaminateEstimateWindow() {
  const executor = loadExecutor()
  const current = record(9, 16)
  const history = [
    record(8, 16),
    record(7, 10),
    record(4, 9),
  ]

  assert.strictEqual(executor.findEstimateBaseRecord(history, current), undefined)

  const schedule = calculate(executor, makeMeter(), current, history[0], undefined)
  assert.strictEqual(schedule.estimatedDailyUsageKwh, 5)
  assert.strictEqual(schedule.isColdStart, true)
}

async function testManualRecordsAreIgnored() {
  const executor = loadExecutor()
  const current = record(4, 16)
  const history = [
    record(3, 17, 'queryPower'),
    record(0, 20, 'queryPower'),
  ]

  assert.strictEqual(executor.findEstimateBaseRecord(history, current), undefined)
}

async function testLowUsageStillUpdatesMeterCurrentState() {
  const executor = loadExecutor()
  const database = {
    serverDate() {
      return atDay(4)
    },
    collection() {
      return {
        add({ data }) {
          database.meter = {
            ...data,
            _id: 'meter-1',
          }
          return Promise.resolve({ _id: 'meter-1' })
        },
        doc() {
          return {
            async update({ data }) {
              Object.assign(database.meter, data)
              return { stats: { updated: 1 } }
            },
          }
        },
      }
    },
    meter: makeMeter(),
  }
  const current = record(4, 19.6)
  const base = record(0, 20)

  await executor.updateMeter(database, database.meter, current, 'light', {
    previousRecord: record(3, 19.7),
    estimateBaseRecord: base,
  })

  assert.strictEqual(database.meter.lastRemainingKwh, 19.6)
  assert.strictEqual(database.meter.lastQueriedAt.getTime(), current.queriedAt.getTime())
  assert.strictEqual(database.meter.estimatedDailyUsageKwh, 5)
  assert.strictEqual(database.meter.isColdStart, true)
}

async function testCheckIntervalCapsAndColdStartTransition() {
  const executor = loadExecutor()

  const firstValidUpdate = calculate(
    executor,
    makeMeter(),
    record(4, 100),
    record(3, 105),
    record(0, 120),
  )
  assert.strictEqual(firstValidUpdate.dailyUsageUpdated, true)
  assert.strictEqual(firstValidUpdate.isColdStart, false)
  // 首次有效更新仍使用进入本轮时的 4 天冷启动上限。
  assert.strictEqual(daysBetween(firstValidUpdate.nextCheckAt, atDay(4)), 4)

  const stable = calculate(
    executor,
    { ...makeMeter(), isColdStart: false },
    record(0, 100),
    undefined,
    undefined,
  )
  assert.strictEqual(stable.isColdStart, false)
  assert.strictEqual(daysBetween(stable.nextCheckAt, atDay(0)), 12)

  const missingField = calculate(
    executor,
    makeMeter(),
    record(0, 100),
    undefined,
    undefined,
  )
  assert.strictEqual(missingField.isColdStart, true)
  assert.strictEqual(daysBetween(missingField.nextCheckAt, atDay(0)), 4)

  const lowPower = calculate(executor, makeMeter(), record(0, 20), undefined, undefined)
  assert.strictEqual(daysBetween(lowPower.nextCheckAt, atDay(0)), 1)

  const nearThreshold = calculate(executor, makeMeter(), record(0, 25), undefined, undefined)
  assert.strictEqual(daysBetween(nearThreshold.nextCheckAt, atDay(0)), 1)

  const failed = calculate(executor, makeMeter(), {
    meterId: 'LIGHT-001',
    ok: false,
    queriedAt: atDay(0),
  }, undefined, undefined)
  assert.strictEqual(daysBetween(failed.nextCheckAt, atDay(0)), 10 / (24 * 60))
  assert.strictEqual(failed.isColdStart, true)

  const recharged = calculate(
    executor,
    { ...makeMeter(), isColdStart: false },
    record(1, 80),
    record(0, 70),
    record(-4, 100),
  )
  assert.strictEqual(recharged.rechargeDetected, true)
  assert.strictEqual(recharged.isColdStart, false, 'recharge should not restart cold-start phase')
}

async function testUpdateMeterPassesEstimateBaseAndPersistsColdStart() {
  const executor = loadExecutor()
  const database = {
    serverDate() {
      return atDay(4)
    },
    collection() {
      return {
        add({ data }) {
          database.meter = {
            ...data,
            _id: 'meter-1',
          }
          return Promise.resolve({ _id: 'meter-1' })
        },
        doc() {
          return {
            async update({ data }) {
              Object.assign(database.meter, data)
              return { stats: { updated: 1 } }
            },
          }
        },
      }
    },
    meter: makeMeter(),
  }
  const current = record(4, 100)
  const base = record(0, 160)

  await executor.updateMeter(database, database.meter, current, 'light', {
    previousRecord: record(3, 105),
    estimateBaseRecord: base,
  })

  // 160 -> 100 over 4 days gives observed=15; the rising-spike formula yields 11.
  assertClose(database.meter.estimatedDailyUsageKwh, 11)
  assert.strictEqual(database.meter.isColdStart, false)
  assert.strictEqual(daysBetween(database.meter.nextCheckAt, current.queriedAt), 4)
}

async function main() {
  testExecutorCopiesStayInSync()
  await testEstimateBaseUsesFourDayWindow()
  await testShortWindowDoesNotUpdate()
  await testLowUsageIsIgnoredButExactThresholdIsAccepted()
  await testDailyUsageFormulaBranches()
  await testPositiveEstimateBelowLegacyFloorIsUsable()
  await testRechargeDoesNotContaminateEstimateWindow()
  await testManualRecordsAreIgnored()
  await testLowUsageStillUpdatesMeterCurrentState()
  await testCheckIntervalCapsAndColdStartTransition()
  await testUpdateMeterPassesEstimateBaseAndPersistsColdStart()
  console.log('OK: scheduled estimate tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
