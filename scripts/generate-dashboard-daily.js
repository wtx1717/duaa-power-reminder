const fs = require('fs')
const path = require('path')
const vm = require('vm')

const COLLECTIONS = {
  snapshots: 'ops_dashboard_snapshots',
}

const START_MARKER = '/* DASHBOARD_SNAPSHOTS_START */'
const END_MARKER = '/* DASHBOARD_SNAPSHOTS_END */'

const DEFAULT_DOTENV_PATH = path.resolve(__dirname, '..', '.env')
const DEFAULT_TEMPLATE_PATH = 'D:\\桌面\\最终样式确定.html'
const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, '..', 'outputs', 'ops', 'dashboard-daily.html')
const DEFAULT_SNAPSHOT_STORE_DIR = path.resolve(__dirname, '..', 'outputs', 'ops', 'snapshots')
let lastWrittenOutputPath = DEFAULT_OUTPUT_PATH

function resolveCloudbaseSdk() {
  const candidates = [
    '@cloudbase/node-sdk',
    path.resolve(__dirname, '..', 'cloudfunctions', 'queryPower', 'node_modules', '@cloudbase', 'node-sdk'),
    path.resolve(__dirname, '..', 'cloudfunctions', 'login', 'node_modules', '@cloudbase', 'node-sdk'),
    path.resolve(__dirname, '..', 'cloudfunctions', 'saveConfig', 'node_modules', '@cloudbase', 'node-sdk'),
  ]

  let lastError = null

  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch (error) {
      lastError = error
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || 'unknown error')
  throw new Error(`无法加载 @cloudbase/node-sdk，请先确认依赖已安装。最后一次错误：${message}`)
}

function parseDotEnvContent(content) {
  const values = Object.create(null)
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const segments = line.split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*\s*=)/)

    for (const segment of segments) {
      const equalsIndex = segment.indexOf('=')
      if (equalsIndex < 0) {
        continue
      }

      const key = segment.slice(0, equalsIndex).trim().replace(/^export\s+/, '')
      if (!key) {
        continue
      }

      let value = segment.slice(equalsIndex + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, '\\')
      }

      values[key] = value
    }
  }

  return values
}

function loadDotEnvFile(dotenvPath = DEFAULT_DOTENV_PATH) {
  if (!dotenvPath || !fs.existsSync(dotenvPath)) {
    return Object.create(null)
  }

  return parseDotEnvContent(fs.readFileSync(dotenvPath, 'utf8'))
}

function getEnvValue(localEnv, names) {
  for (const name of names) {
    const localValue = localEnv && localEnv[name]
    if (localValue !== undefined && localValue !== '') {
      return localValue
    }
  }

  for (const name of names) {
    const processValue = process.env[name]
    if (processValue !== undefined && processValue !== '') {
      return processValue
    }
  }

  return ''
}

function resolveCloudbaseOptions(dotenvPath = DEFAULT_DOTENV_PATH) {
  const localEnv = loadDotEnvFile(dotenvPath)
  const env = getEnvValue(localEnv, ['CLOUDBASE_ENV_ID', 'TCB_ENV_ID', 'TCB_ENV', 'CLOUDBASE_ENV'])
  const accessKey = getEnvValue(localEnv, ['CLOUDBASE_APIKEY', 'TCB_APIKEY'])
  const secretId = getEnvValue(localEnv, ['TENCENTCLOUD_SECRETID', 'CLOUDBASE_SECRETID', 'TCB_SECRETID'])
  const secretKey = getEnvValue(localEnv, ['TENCENTCLOUD_SECRETKEY', 'CLOUDBASE_SECRETKEY', 'TCB_SECRETKEY'])
  const sessionToken = getEnvValue(localEnv, ['TENCENTCLOUD_SESSIONTOKEN', 'TCB_SESSIONTOKEN'])

  if (!env) {
    throw new Error('缺少云环境 ID，请设置 CLOUDBASE_ENV_ID 或 TCB_ENV_ID。')
  }

  if (!accessKey && (!secretId || !secretKey)) {
    throw new Error('缺少云访问密钥，请设置 TENCENTCLOUD_SECRETID 和 TENCENTCLOUD_SECRETKEY。')
  }

  return accessKey ? { env, accessKey } : { env, secretId, secretKey, sessionToken }
}

function sortSnapshots(snapshots) {
  return snapshots
    .filter((item) => item && item.snapshotDate)
    .slice()
    .sort((left, right) => String(right.snapshotDate).localeCompare(String(left.snapshotDate)))
}

function getBeijingTodayDate() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function buildSnapshotManifest(snapshots) {
  const sorted = sortSnapshots(snapshots)
  const latestSuccessful = sorted.find((item) => item.status === 'success') || null
  const today = getBeijingTodayDate()
  const todaySnapshot = sorted.find((item) => item.snapshotDate === today) || null
  const defaultSnapshotDate = (todaySnapshot && todaySnapshot.snapshotDate)
    || (latestSuccessful && latestSuccessful.snapshotDate)
    || (sorted[0] && sorted[0].snapshotDate)
    || ''

  return {
    generatedAt: new Date().toISOString(),
    defaultSnapshotDate,
    latestSuccessfulSnapshotDate: latestSuccessful ? latestSuccessful.snapshotDate : '',
    latestSnapshotDate: sorted[0] ? sorted[0].snapshotDate : '',
    snapshotCount: sorted.length,
    snapshotDates: sorted.map((item) => item.snapshotDate),
    entries: sorted.map((item) => ({
      snapshotDate: item.snapshotDate,
      generatedAt: item.generatedAt || '',
      status: item.status || 'success',
      file: `${item.snapshotDate}.json`,
    })),
  }
}

function writeTextIfChanged(filePath, text) {
  const content = String(text)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf8')
    if (current === content) {
      return false
    }
  }

  fs.writeFileSync(filePath, content, 'utf8')
  return true
}

function writeJsonIfChanged(filePath, value) {
  return writeTextIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeLocalSnapshotStore(storePath, snapshots) {
  const sorted = sortSnapshots(snapshots)
  const manifest = buildSnapshotManifest(sorted)
  fs.mkdirSync(storePath, { recursive: true })

  for (const entry of fs.readdirSync(storePath)) {
    if (entry.toLowerCase().endsWith('.js')) {
      fs.unlinkSync(path.join(storePath, entry))
    }
  }

  writeJsonIfChanged(path.join(storePath, 'index.json'), manifest)

  for (const snapshot of sorted) {
    writeJsonIfChanged(path.join(storePath, `${snapshot.snapshotDate}.json`), snapshot)
  }

  return manifest
}

function replaceOnce(text, search, replacement) {
  const index = text.indexOf(search)
  if (index < 0) {
    throw new Error(`无法在模板中找到片段：${search.slice(0, 40)}`)
  }

  return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`
}

function extractScriptBlock(html) {
  const match = String(html).match(/<script>([\s\S]*)<\/script>/i)
  if (!match) {
    throw new Error('无法从 HTML 中提取脚本块。')
  }

  return match[1].trim()
}

function extractEmbeddedSnapshots(script) {
  const match = String(script).match(/const dashboardSnapshots = (\[[\s\S]*?\]);/)
  if (!match) {
    throw new Error('无法从脚本中提取快照数据。')
  }

  return vm.runInNewContext(`(${match[1]})`, Object.create(null))
}

function buildSnapshotBlock(snapshots) {
  const json = JSON.stringify(sortSnapshots(snapshots), null, 2)

  return [
    `    ${START_MARKER}`,
    `    const dashboardSnapshots = ${json};`,
    `    ${END_MARKER}`,
  ].join('\n')
}

function injectSnapshotsIntoScript(script, snapshots) {
  const block = buildSnapshotBlock(snapshots)
  const startToken = `    ${START_MARKER}`
  const endToken = `    ${END_MARKER}`
  const startIndex = script.indexOf(startToken)
  const endIndex = script.indexOf(endToken)

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error('无法找到脚本中的快照占位区。')
  }

  return `${script.slice(0, startIndex)}${block}${script.slice(endIndex + endToken.length)}`
}

function loadTemplateHtml(templatePath = DEFAULT_TEMPLATE_PATH) {
  return fs.readFileSync(templatePath, 'utf8').replace(/\\r\\n/g, '\\n')
}

function buildRuntimeScript() {
  const runtimePath = path.resolve(__dirname, 'dashboard-runtime.js')
  return fs.readFileSync(runtimePath, 'utf8')
}
function injectDesktopTemplateShell(html) {
  const stylesheetSnippet = `
    .snapshot-picker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 0 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
    }

    .snapshot-picker label {
      white-space: nowrap;
    }

    .snapshot-picker select {
      min-width: 132px;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
    }

    .snapshot-note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .refresh-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
    }

    .refresh-btn:hover {
      border-color: rgba(42, 105, 199, 0.35);
      color: var(--blue);
    }

    .refresh-btn:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    .tag.done {
      color: var(--green);
      background: rgba(31, 122, 90, 0.08);
    }

    .tag.running,
    .tag.expired {
      color: var(--blue);
      background: rgba(42, 105, 199, 0.08);
    }

    .job-table {
      min-width: 980px;
    }

    .job-table-shell {
      max-height: 420px;
      overflow: hidden;
    }

    .job-table-scroll {
      max-height: 360px;
      overflow: auto;
    }

    .job-table thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #fff;
    }
`

  const topbarSnippet = `
      <div class="brand-row">
        <div class="brand">
          <h1>宿舍电量运维看板</h1>
          <div class="snapshot-note" id="snapshotNote">离线日报快照</div>
        </div>
        <div class="meta-row">
          <div class="snapshot-picker">
            <label for="snapshotDateSelect">查看日期</label>
            <select id="snapshotDateSelect" aria-label="选择快照日期"></select>
          </div>
          <button class="refresh-btn" id="refreshDataBtn" type="button">更新数据</button>
          <span class="meta-chip" id="snapshotUpdatedAt">更新时间 -</span>
          <span class="meta-chip" id="refreshStatus">本地离线模式</span>
        </div>
      </div>
      <div class="kpi-grid" id="kpiGrid"></div>
`

  html = html.replace(/<div class="brand-row">[\s\S]*?<div class="kpi-grid" id="kpiGrid"><\/div>/, topbarSnippet)
  html = html.replace(/(<section class="section">\s*<div class="section-head">\s*<div class="section-title">\s*<h2>电表栏目区<\/h2>[\s\S]*?<div class="meter-grid" id="meterGrid"><\/div>\s*<\/div>\s*<\/div>\s*<\/section>)\s*<section class="section">\s*<div class="section-head">\s*<div class="section-title">\s*<h2>邮件通知明细<\/h2>/, `$1\n\n      <section class="section">\n        <div class="section-head">\n          <div class="section-title">\n            <h2>定时任务明细</h2>\n          </div>\n        </div>\n        <div class="section-body job-table-shell" style="padding-bottom: 0;">\n          <div class="job-table-scroll table-wrap">\n            <table class="job-table">\n              <thead>\n                <tr>\n                  <th>任务</th>\n                  <th>电表号</th>\n                  <th>类型</th>\n                  <th>状态</th>\n                  <th>规划时间</th>\n                  <th>完成时间</th>\n                  <th>尝试次数</th>\n                  <th>错误信息</th>\n                </tr>\n              </thead>\n              <tbody id="jobTable"></tbody>\n            </table>\n          </div>\n        </div>\n      </section>\n\n      <section class="section">\n        <div class="section-head">\n          <div class="section-title">\n            <h2>邮件通知明细</h2>`) 
  html = html.replace(/    @media \(max-width: 1480px\) \{/, `${stylesheetSnippet}\n\n    @media (max-width: 1480px) {`)
  html = html.replace(/<script>[\s\S]*<\/script>/i, `<script>\n${buildRuntimeScript()}\n  </script>`)

  return html
}

function readAllDocuments(collection, pageSize = 500) {
  const documents = []
  const baseQuery = typeof collection.where === 'function' ? collection.where({}) : collection
  const canPaginate = typeof baseQuery.skip === 'function' && typeof baseQuery.limit === 'function'

  if (!canPaginate) {
    return baseQuery.get().then((response) => (Array.isArray(response.data) ? response.data : []))
  }

  return (async () => {
    let offset = 0

    for (let page = 0; page < 200; page += 1) {
      let query = baseQuery

      if (offset > 0) {
        query = query.skip(offset)
      }

      query = query.limit(pageSize)

      const response = await query.get()
      const pageData = Array.isArray(response.data) ? response.data : []
      documents.push(...pageData)

      if (pageData.length < pageSize) {
        break
      }

      offset += pageData.length
    }

    return documents
  })()
}

async function readSnapshotsFromDatabase(db) {
  const collection = db.collection(COLLECTIONS.snapshots)
  return sortSnapshots(await readAllDocuments(collection))
}

async function loadEmbeddedSnapshots() {
  return []
}

function writeOutputHtml(outputPath, html) {
  try {
    writeTextIfChanged(outputPath, html)
    lastWrittenOutputPath = outputPath
    return outputPath
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : ''
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      const fallbackPath = outputPath.replace(/\.html$/i, `.generated${Date.now()}.html`)
      writeTextIfChanged(fallbackPath, html)
      lastWrittenOutputPath = fallbackPath
      return fallbackPath
    }

    throw error
  }
}

async function generateDashboardFile({
  templatePath = DEFAULT_TEMPLATE_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
  snapshotStorePath = DEFAULT_SNAPSHOT_STORE_DIR,
  snapshots,
}) {
  const templateHtml = loadTemplateHtml(templatePath)
  writeLocalSnapshotStore(snapshotStorePath, snapshots)
  const rendered = injectDesktopTemplateShell(templateHtml)

  writeOutputHtml(outputPath, rendered)
  return rendered
}

async function main() {
  const templatePath = DEFAULT_TEMPLATE_PATH
  const outputPath = DEFAULT_OUTPUT_PATH
  const snapshotStorePath = DEFAULT_SNAPSHOT_STORE_DIR
  let snapshots
  let source = 'embedded'
  let manifest

  try {
    const cloudbase = resolveCloudbaseSdk()
    const options = resolveCloudbaseOptions()
    const app = cloudbase.init(options)
    snapshots = await readSnapshotsFromDatabase(app.database())
    manifest = buildSnapshotManifest(snapshots)
    source = 'cloud'
  } catch (error) {
    snapshots = await loadEmbeddedSnapshots()
    manifest = buildSnapshotManifest(snapshots)
    source = 'embedded-empty'
  }

  await generateDashboardFile({ templatePath, outputPath, snapshotStorePath, snapshots })

  console.log(JSON.stringify({
    templatePath,
    outputPath,
    snapshotStorePath,
    actualOutputPath: lastWrittenOutputPath,
    snapshotCount: snapshots.length,
    defaultSnapshotDate: manifest.defaultSnapshotDate,
    source,
  }, null, 2))
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  buildSnapshotBlock,
  buildSnapshotManifest,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_DOTENV_PATH,
  DEFAULT_SNAPSHOT_STORE_DIR,
  DEFAULT_TEMPLATE_PATH,
  generateDashboardFile,
  injectDesktopTemplateShell,
  loadEmbeddedSnapshots,
  loadDotEnvFile,
  loadTemplateHtml,
  main,
  parseDotEnvContent,
  readAllDocuments,
  readSnapshotsFromDatabase,
  replaceOnce,
  resolveCloudbaseOptions,
  resolveCloudbaseSdk,
  sortSnapshots,
  writeJsonIfChanged,
  writeLocalSnapshotStore,
  writeOutputHtml,
  writeTextIfChanged,
}





