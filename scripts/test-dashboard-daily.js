const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

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
  assert(html.includes('运维看板预览') || html.includes('宿舍电量运维看板'), 'template should load from the desktop file')
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
        meters: [{ meterId: 'M-001', type: 'light', state: 'normal', stateText: '正常', currentKwh: 10, dailyUsageKwh: 1, failCount: 0, nextCheckAt: '2026-09-04T05:00:00.000Z' }],
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
  assert(rendered.includes('snapshotDateSelect'), 'generated html should include snapshot selector')
  assert(rendered.includes('refreshDataBtn'), 'generated html should include refresh button')
  assert(rendered.includes('jobTable'), 'generated html should include job table')
  assert(!rendered.includes('const dashboardSnapshots = ['), 'generated html should not embed full snapshot data')
  assert(rendered.includes('const REFRESH_API_URL ='), 'generated html should include preview server endpoint')

  fs.unlinkSync(outputPath)
  fs.rmSync(snapshotStorePath, { recursive: true, force: true })
}

function testSnapshotManifest() {
  const manifest = buildSnapshotManifest([
    { snapshotDate: '2026-09-04', status: 'success', generatedAt: '2026-09-04T15:00:00.000Z' },
    { snapshotDate: '2026-09-05', status: 'partial', generatedAt: '2026-09-05T15:00:00.000Z' },
  ])

  assert.strictEqual(manifest.defaultSnapshotDate, '2026-09-05')
  assert.strictEqual(manifest.snapshotCount, 2)
  assert.deepStrictEqual(manifest.snapshotDates, ['2026-09-05', '2026-09-04'])
}

async function main() {
  testSortSnapshots()
  testTemplatePath()
  testDotEnvParsing()
  testDotEnvFileLoading()
  testSnapshotManifest()
  await testGenerateDashboardFile()
  console.log('OK: dashboard daily helper tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
