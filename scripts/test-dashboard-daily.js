// 看板生成脚本测试。
// 使用临时目录验证 .env 解析、快照索引、本地快照存储和 HTML 注入。
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const {
  DEFAULT_TEMPLATE_PATH,
  generateDashboardFile,
  loadDotEnvFile,
  loadTemplateHtml,
  parseDotEnvContent,
  buildSnapshotManifest,
  sortSnapshots,
} = require('./generate-dashboard-daily')

function testSortSnapshots() {
  // 快照必须按日期倒序，最新日期放在前面。
  const snapshots = sortSnapshots([
    { snapshotDate: '2026-09-03' },
    { snapshotDate: '2026-09-05' },
    { snapshotDate: '2026-09-04' },
  ])

  assert.deepStrictEqual(
    snapshots.map((item) => item.snapshotDate),
    ['2026-09-05', '2026-09-04', '2026-09-03'],
  )
}

function testTemplatePath() {
  const html = loadTemplateHtml(DEFAULT_TEMPLATE_PATH)
  assert(html.includes('运维看板预览') || html.includes('宿舍电量运维看板'), 'template should load from the project file')
  assert(fs.existsSync(DEFAULT_TEMPLATE_PATH), 'template should exist in the project templates directory')
}

function testDotEnvParsing() {
  const parsed = parseDotEnvContent(`\n# comment\nexport CLOUDBASE_ENV_ID=env-123\nTENCENTCLOUD_SECRETID="sid-abc"\nTENCENTCLOUD_SECRETKEY='sk-xyz'\nEMPTY_VALUE=\n`)

  assert.strictEqual(parsed.CLOUDBASE_ENV_ID, 'env-123')
  assert.strictEqual(parsed.TENCENTCLOUD_SECRETID, 'sid-abc')
  assert.strictEqual(parsed.TENCENTCLOUD_SECRETKEY, 'sk-xyz')
  assert.strictEqual(parsed.EMPTY_VALUE, '')
}

function testDotEnvFileLoading() {
  const tempEnvPath = path.join(os.tmpdir(), `dashboard-test-${Date.now()}.env`)
  fs.writeFileSync(tempEnvPath, 'CLOUDBASE_ENV_ID=file-env\n', 'utf8')

  try {
    const parsed = loadDotEnvFile(tempEnvPath)
    assert.strictEqual(parsed.CLOUDBASE_ENV_ID, 'file-env')
  } finally {
    fs.unlinkSync(tempEnvPath)
  }
}

async function testGenerateDashboardFile() {
  // 生成结果应引用外部快照索引，而不是把完整快照数组嵌入 HTML。
  const outputPath = path.join(os.tmpdir(), `dashboard-daily-${Date.now()}.html`)
  const snapshotStorePath = path.join(os.tmpdir(), `dashboard-snapshots-${Date.now()}`)
  const rendered = await generateDashboardFile({
    templatePath: DEFAULT_TEMPLATE_PATH,
    outputPath,
    snapshotStorePath,
    snapshots: [
      {
        snapshotDate: '2026-09-04',
        generatedAt: '2026-09-04T15:00:00.000Z',
        status: 'success',
        kpis: [{ label: '用户数量', value: '1', foot: '已绑定账号' }],
        summary: [{ key: 'normal', title: '正常状态', count: 1, note: '运行稳定' }],
        meters: [{ meterId: 'M-001', type: 'light', state: 'normal', stateText: '正常', currentKwh: 10, dailyUsageKwh: 1, failCount: 0, nextCheckAt: '2026-09-04T05:00:00.000Z', isColdStart: true }],
        powerRecords: [],
        notificationRecords: [],
        jobRecords: [],
      },
    ],
  })

  assert(fs.existsSync(outputPath), 'output html should be written')
  assert(fs.existsSync(path.join(snapshotStorePath, 'index.json')), 'snapshot index json should be written')
  assert(fs.existsSync(path.join(snapshotStorePath, '2026-09-04.json')), 'daily snapshot json should be written')
  assert(!fs.existsSync(path.join(snapshotStorePath, 'index.js')), 'snapshot js wrappers should not be written')
  assert(!fs.existsSync(path.join(snapshotStorePath, '2026-09-04.js')), 'daily snapshot js wrappers should not be written')
  assert(rendered.includes('snapshotMonthToggle'), 'generated html should include month toggle')
  assert(rendered.includes('snapshotMonthList'), 'generated html should include month list')
  assert(rendered.includes('snapshotCalendar'), 'generated html should include calendar selector')
  assert(rendered.includes('refreshDataBtn'), 'generated html should include refresh button')
  assert(rendered.includes('<div class="meter-matrix" id="meterMatrix">'), 'generated html should include meter matrix container')
  assert(rendered.includes('<div class="meter-grid" id="meterGrid">'), 'generated html should include meter card container')
  assert(rendered.includes('<tbody id="jobTable"></tbody>'), 'generated html should include job table container')
  assert(rendered.includes('cold-start-badge'), 'generated html should include cold-start badge styles and renderer')
  assert(rendered.includes('估算阶段'), 'generated html should include estimate stage detail')
  assert(rendered.includes('阶段未知'), 'generated html should support legacy snapshots without stage field')
  assert(!rendered.includes('const dashboardSnapshots = ['), 'generated html should not embed full snapshot data')
  assert(rendered.includes('const REFRESH_API_URL ='), 'generated html should include preview server endpoint')

  fs.unlinkSync(outputPath)
  fs.rmSync(snapshotStorePath, { recursive: true, force: true })
}

function testTemplatePathResolution() {
  const resolved = require('./generate-dashboard-daily').resolveDashboardTemplatePath()
  assert.strictEqual(resolved, DEFAULT_TEMPLATE_PATH)
}

function testSnapshotManifest() {
  const manifest = buildSnapshotManifest([
    { snapshotDate: '2026-09-04', status: 'success', generatedAt: '2026-09-04T15:00:00.000Z' },
    { snapshotDate: '2026-09-05', status: 'partial', generatedAt: '2026-09-05T15:00:00.000Z' },
  ])

  assert.strictEqual(manifest.defaultSnapshotDate, '2026-09-04')
  assert.strictEqual(manifest.snapshotCount, 2)
  assert.deepStrictEqual(manifest.snapshotDates, ['2026-09-05', '2026-09-04'])
}

function testDashboardMeterStages() {
  // 只执行运行时的数据适配部分，避免测试依赖浏览器 DOM。
  const runtimePath = path.join(__dirname, 'dashboard-runtime.js')
  const runtimeSource = fs.readFileSync(runtimePath, 'utf8')
  const mainMarker = '// 使用立即执行函数隔离局部变量'
  const adapterSource = runtimeSource.slice(0, runtimeSource.indexOf(mainMarker))
  const context = {
    window: { location: { origin: 'http://127.0.0.1:33123' } },
  }

  vm.runInNewContext(`${adapterSource}\nthis.runtimeAdapters = { normalizeMeter, snapshotToDashboard };`, context)
  const { normalizeMeter, snapshotToDashboard } = context.runtimeAdapters
  const cold = normalizeMeter({ meterId: 'cold', type: 'light', state: 'normal', isColdStart: true })
  const stable = normalizeMeter({ meterId: 'stable', type: 'ac', state: 'normal', isColdStart: false })
  const legacy = normalizeMeter({ meterId: 'legacy', type: 'light', state: 'normal' })

  assert.strictEqual(cold.coldStartText, '冷启动')
  assert.strictEqual(stable.coldStartText, '稳定阶段')
  assert.strictEqual(legacy.coldStartText, '阶段未知')
  assert.strictEqual(legacy.coldStartKnown, false)
  assert.strictEqual(cold.state, 'normal', 'cold-start stage should not change health state')

  const dashboard = snapshotToDashboard({
    meters: [
      { meterId: 'cold', type: 'light', state: 'warn', isColdStart: true },
      { meterId: 'legacy', type: 'ac', state: 'error' },
    ],
  })
  assert.strictEqual(dashboard.meters[0].state, 'warn')
  assert.strictEqual(dashboard.meters[0].coldStartText, '冷启动')
  assert.strictEqual(dashboard.meters[1].state, 'error')
  assert.strictEqual(dashboard.meters[1].coldStartText, '阶段未知')
}

async function main() {
  testSortSnapshots()
  testTemplatePath()
  testTemplatePathResolution()
  testDotEnvParsing()
  testDotEnvFileLoading()
  testSnapshotManifest()
  testDashboardMeterStages()
  await testGenerateDashboardFile()
  console.log('OK: dashboard daily helper tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
