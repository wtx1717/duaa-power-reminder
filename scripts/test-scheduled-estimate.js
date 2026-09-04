const assert = require('assert')
const Module = require('module')

const EXECUTOR_PATH = '../cloudfunctions/scheduledCheckDispatch/shared/scheduledExecutor.js'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

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
  assert.strictEqual(schedule.estimatedDailyUsageKwh, 4.2)
}

async function testShortWindowDoesNotUpdate() {
  const executor = loadExecutor()
  const current = record(3, 16)
  const base = record(0, 20)

  const schedule = calculate(executor, makeMeter(), current, record(2, 18), base)
  assert.strictEqual(schedule.estimatedDailyUsageKwh, 5)
}

async function testLowUsageIsIgnoredButExactThresholdIsAccepted() {
  const executor = loadExecutor()
  const base = record(0, 20)

  const lowUsage = calculate(executor, makeMeter(), record(4, 16.04), record(3, 16.3), base)
  assert.strictEqual(lowUsage.estimatedDailyUsageKwh, 5)

  const thresholdUsage = calculate(executor, makeMeter(), record(4, 16), record(3, 16.3), base)
  assert.strictEqual(thresholdUsage.estimatedDailyUsageKwh, 4.2)
}

async function testPositiveEstimateBelowLegacyFloorIsUsable() {
  const executor = loadExecutor()
  const base = record(0, 20)
  const schedule = calculate(executor, makeMeter(0.4), record(4, 16), record(3, 16.5), base)

  assert.strictEqual(schedule.estimatedDailyUsageKwh, 0.52)
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
}

async function main() {
  await testEstimateBaseUsesFourDayWindow()
  await testShortWindowDoesNotUpdate()
  await testLowUsageIsIgnoredButExactThresholdIsAccepted()
  await testPositiveEstimateBelowLegacyFloorIsUsable()
  await testRechargeDoesNotContaminateEstimateWindow()
  await testManualRecordsAreIgnored()
  await testLowUsageStillUpdatesMeterCurrentState()
  console.log('OK: scheduled estimate tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
