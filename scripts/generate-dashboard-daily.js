// 运营看板生成脚本。
// 负责读取云数据库快照、维护本地快照文件，并把运行时脚本注入 HTML 模板。
const fs = require('fs')
const path = require('path')
const os = require('os')
const vm = require('vm')

const COLLECTIONS = {
  snapshots: 'ops_dashboard_snapshots',
}

const START_MARKER = '/* DASHBOARD_SNAPSHOTS_START */'
const END_MARKER = '/* DASHBOARD_SNAPSHOTS_END */'

const DEFAULT_DOTENV_PATH = path.resolve(__dirname, '..', '.env')
const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', 'ops', 'dashboard-template.html')
const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, '..', 'outputs', 'ops', 'dashboard-daily.html')
const DEFAULT_SNAPSHOT_STORE_DIR = path.resolve(__dirname, '..', 'outputs', 'ops', 'snapshots')
const DEFAULT_SNAPSHOT_READ_TIMEOUT_MS = Number(process.env.DASHBOARD_SNAPSHOT_READ_TIMEOUT_MS || 30000)
let lastWrittenOutputPath = DEFAULT_OUTPUT_PATH

function resolveCloudbaseSdk() {
  // 兼容根目录和云函数目录安装依赖的情况，依次寻找可用 SDK。
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
  // 解析简单 .env 文件；这里只读取键值，不执行任何 shell 语法。
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
  // 优先使用 .env 中的值，再回退到当前进程环境变量。
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
  // 组合 CloudBase 环境 ID 和访问凭据；缺少必要配置时返回可读错误。
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
  // 生成看板前端使用的索引，而不是把所有快照正文都塞进 HTML。
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
  // 内容没有变化时不写文件，减少无意义的时间戳和文件系统操作。
  const content = String(text)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf8')
    if (current === content) {
      return false
    }
  }

  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.writeFileSync(filePath, content, 'utf8')
      return true
    } catch (error) {
      lastError = error
      const code = error && typeof error === 'object' ? error.code : ''
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
        throw error
      }
      const waitMs = 50 * (attempt + 1)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
    }
  }

  if (lastError) {
    throw lastError
  }

  return false
}

function writeTextAtomic(filePath, text) {
  // 先写临时文件再替换目标文件，降低生成中断留下半个文件的概率。
  const content = String(text)
  const directory = path.dirname(filePath)
  const tempPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)

  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(tempPath, content, 'utf8')

  try {
    fs.renameSync(tempPath, filePath)
    return true
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
      }
    } catch (cleanupError) {
      void cleanupError
    }
    throw error
  }
}

function writeJsonIfChanged(filePath, value) {
  return writeTextIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeLocalSnapshotStore(storePath, snapshots) {
  // 本地只保留 index.json 和按日期拆分的 JSON，浏览器按需加载单日快照。
  const sorted = sortSnapshots(snapshots)
  const manifest = buildSnapshotManifest(sorted)
  fs.mkdirSync(storePath, { recursive: true })

  for (const entry of fs.readdirSync(storePath)) {
    if (entry.toLowerCase().endsWith('.js')) {
      fs.unlinkSync(path.join(storePath, entry))
    }
  }

  const writeFileSafely = (targetPath, value) => {
    try {
      writeJsonIfChanged(targetPath, value)
      return true
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : ''
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        try {
          writeTextAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`)
          return true
        } catch (atomicError) {
          const atomicCode = atomicError && typeof atomicError === 'object' ? atomicError.code : ''
          if (atomicCode === 'EPERM' || atomicCode === 'EACCES' || atomicCode === 'EBUSY') {
            console.warn(`无法写入本地快照文件：${targetPath}。将保留现有文件继续生成页面。`)
            return false
          }
          throw atomicError
        }
      }
      throw error
    }
  }

  writeFileSafely(path.join(storePath, 'index.json'), manifest)

  for (const snapshot of sorted) {
    writeFileSafely(path.join(storePath, `${snapshot.snapshotDate}.json`), snapshot)
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

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error')
}

function resolveDashboardTemplatePath(templatePath) {
  const candidate = templatePath || process.env.DASHBOARD_TEMPLATE_PATH || DEFAULT_TEMPLATE_PATH
  return path.isAbsolute(candidate) ? candidate : path.resolve(__dirname, '..', candidate)
}

function loadTemplateHtml(templatePath) {
  const resolvedPath = resolveDashboardTemplatePath(templatePath)

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`找不到运维看板模板文件：${resolvedPath}。请将模板放到项目内 templates\\ops\\dashboard-template.html，或通过 DASHBOARD_TEMPLATE_PATH 指定模板路径。`)
  }

  return fs.readFileSync(resolvedPath, 'utf8').replace(/\r\n/g, '\n')
}

function buildRuntimeScript() {
  // 读取独立的 dashboard-runtime.js，避免生成脚本和浏览器运行时重复维护。
  const runtimePath = path.resolve(__dirname, 'dashboard-runtime.js')
  return fs.readFileSync(runtimePath, 'utf8')
}
function injectDesktopTemplateShell(html) {
  const stylesheetSnippet = `
    .snapshot-note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .snapshot-picker {
      position: relative;
      display: inline-flex;
      align-items: flex-start;
      gap: 8px;
      max-width: 100%;
      --day-size: 42px;
    }

    .snapshot-picker-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .snapshot-picker-label {
      color: var(--muted);
      font-size: 12px;
    }

    .snapshot-month-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 32px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      box-shadow: var(--shadow);
    }

    .snapshot-month-toggle:hover {
      border-color: rgba(42, 105, 199, 0.35);
      color: var(--blue);
    }

    .snapshot-month-toggle:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .snapshot-month-arrow {
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
      transition: transform 0.15s ease;
    }

    .snapshot-picker.open .snapshot-month-arrow {
      transform: rotate(180deg);
    }

    .snapshot-picker-panel {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      z-index: 12;
      width: min(420px, calc(100vw - 32px));
      max-height: min(72vh, 680px);
      overflow: auto;
      display: grid;
      gap: 8px;
      padding: 10px 12px 12px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 14px 42px rgba(16, 24, 20, 0.12);
    }

    .snapshot-month-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .snapshot-month-item {
      min-width: 96px;
      height: 30px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--text);
      font-size: 12px;
      cursor: pointer;
    }

    .snapshot-month-item:hover {
      border-color: rgba(31, 122, 90, 0.32);
      color: var(--green);
    }

    .snapshot-month-item.active {
      border-color: rgba(42, 105, 199, 0.45);
      background: rgba(42, 105, 199, 0.08);
      color: var(--blue);
      font-weight: 600;
    }

    .snapshot-month-item:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .calendar-head,
    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, var(--day-size));
      justify-content: center;
      gap: 8px;
    }

    .calendar-weekday {
      color: var(--muted);
      font-size: 11px;
      line-height: 18px;
      text-align: center;
    }

    .calendar-cell {
      width: var(--day-size);
      height: var(--day-size);
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 50%;
      background: #fff;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 0;
      font-size: 12px;
      cursor: pointer;
      box-shadow: var(--shadow);
    }

    .calendar-cell.empty {
      visibility: hidden;
      pointer-events: none;
    }

    .calendar-cell.available:hover {
      border-color: rgba(42, 105, 199, 0.38);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(42, 105, 199, 0.10);
    }

    .calendar-cell.disabled {
      background: #f6f7f8;
      color: #bcc4c0;
      cursor: not-allowed;
      box-shadow: none;
    }

    .calendar-cell.active {
      border-color: rgba(42, 105, 199, 0.55);
      background: rgba(42, 105, 199, 0.10);
      color: var(--blue);
    }

    .calendar-cell:focus-visible {
      outline: 2px solid rgba(42, 105, 199, 0.26);
      outline-offset: 2px;
    }

    .calendar-day {
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
    }

    .calendar-dot {
      display: none;
    }

    .calendar-empty {
      padding: 10px 0 2px;
      color: var(--muted);
      font-size: 13px;
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

    @media (max-width: 640px) {
      .snapshot-picker {
        --day-size: 38px;
      }

      .snapshot-picker-panel {
        left: 0;
        right: auto;
        width: min(100vw - 24px, 420px);
      }
    }

    @media (max-width: 420px) {
      .snapshot-picker {
        --day-size: 34px;
      }
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
          <div class="snapshot-picker" id="snapshotPicker">
            <div class="snapshot-picker-bar">
              <span class="snapshot-picker-label">查看月份</span>
              <button class="snapshot-month-toggle" id="snapshotMonthToggle" type="button" aria-expanded="false" aria-controls="snapshotPickerPanel">
                <span class="snapshot-month-label" id="snapshotMonthLabel">暂无本地快照</span>
                <span class="snapshot-month-arrow" aria-hidden="true">▾</span>
              </button>
            </div>
            <div class="snapshot-picker-panel" id="snapshotPickerPanel" hidden>
              <div class="snapshot-month-list" id="snapshotMonthList"></div>
              <div id="snapshotCalendar" aria-label="日期日历"></div>
            </div>
          </div>
          <button class="refresh-btn" id="refreshDataBtn" type="button">更新数据</button>
          <span class="meta-chip" id="snapshotUpdatedAt">更新时间 -</span>
          <span class="meta-chip" id="refreshStatus">本地离线模式</span>
        </div>
      </div>
      <div class="kpi-grid" id="kpiGrid"></div>
`

  html = html.replace(/<div class="brand-row">[\s\S]*?<div class="kpi-grid" id="kpiGrid"><\/div>/, topbarSnippet)
  // 区块之间的说明性 HTML 注释不应阻断后续任务明细注入。
  html = html.replace(/(<\/section>)\s*<!--\s*通知明细表：[^\r\n]*-->\s*(<section class="section">\s*<div class="section-head">\s*<div class="section-title">\s*<h2>邮件通知明细<\/h2>)/, '$1\n\n$2')
  html = html.replace(/(<section class="section">\s*<div class="section-head">\s*<div class="section-title">\s*<h2>电表栏目区<\/h2>[\s\S]*?<div class="meter-grid" id="meterGrid"><\/div>\s*<\/div>\s*<\/div>\s*<\/section>)\s*<section class="section">\s*<div class="section-head">\s*<div class="section-title">\s*<h2>邮件通知明细<\/h2>/, `$1\n\n      <section class="section">\n        <div class="section-head">\n          <div class="section-title">\n            <h2>定时任务明细</h2>\n          </div>\n        </div>\n        <div class="section-body job-table-shell" style="padding-bottom: 0;">\n          <div class="job-table-scroll table-wrap">\n            <table class="job-table">\n              <thead>\n                <tr>\n                  <th>任务</th>\n                  <th>电表号</th>\n                  <th>类型</th>\n                  <th>状态</th>\n                  <th>规划时间</th>\n                  <th>完成时间</th>\n                  <th>尝试次数</th>\n                  <th>错误信息</th>\n                </tr>\n              </thead>\n              <tbody id="jobTable"></tbody>\n            </table>\n          </div>\n        </div>\n      </section>\n\n      <section class="section">\n        <div class="section-head">\n          <div class="section-title">\n            <h2>邮件通知明细</h2>`) 
  html = html.replace(/    @media \(max-width: 1480px\) \{/, `${stylesheetSnippet}\n\n    @media (max-width: 1480px) {`)
  html = html.replace(/<script>[\s\S]*<\/script>/i, `<script>\n${buildRuntimeScript()}\n  </script>`)

  return html
}

function readAllDocuments(collection, pageSize = 500) {
  // 分页读取 CloudBase 集合，兼容没有 skip API 的简化 Mock。
  const documents = []
  const baseQuery = typeof collection.where === 'function' ? collection.where({}) : collection
  const canPaginate = typeof baseQuery.skip === 'function' && typeof baseQuery.limit === 'function'
  const applyTimeout = (query) => (typeof query.options === 'function'
    ? query.options({ timeout: DEFAULT_SNAPSHOT_READ_TIMEOUT_MS })
    : query)

  if (!canPaginate) {
    return applyTimeout(baseQuery).get().then((response) => (Array.isArray(response.data) ? response.data : []))
  }

  return (async () => {
    let offset = 0

    for (let page = 0; page < 200; page += 1) {
      let query = baseQuery

      if (offset > 0) {
        query = query.skip(offset)
      }

      query = query.limit(pageSize)
      query = applyTimeout(query)

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

async function loadEmbeddedSnapshots(snapshotStorePath = DEFAULT_SNAPSHOT_STORE_DIR) {
  // 生成失败或离线时读取本地已有快照，保证看板仍可预览。
  if (!snapshotStorePath || !fs.existsSync(snapshotStorePath)) {
    return []
  }

  const indexPath = path.join(snapshotStorePath, 'index.json')
  let snapshotDates = []

  if (fs.existsSync(indexPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      if (Array.isArray(manifest.snapshotDates) && manifest.snapshotDates.length) {
        snapshotDates = manifest.snapshotDates.slice()
      }
    } catch (error) {
      snapshotDates = []
    }
  }

  if (!snapshotDates.length) {
    snapshotDates = fs.readdirSync(snapshotStorePath)
      .filter((entry) => /^\d{4}-\d{2}-\d{2}\.json$/i.test(entry))
      .map((entry) => entry.replace(/\.json$/i, ''))
  }

  const snapshots = []
  for (const snapshotDate of snapshotDates) {
    const filePath = path.join(snapshotStorePath, `${snapshotDate}.json`)
    if (!fs.existsSync(filePath)) {
      continue
    }

    try {
      snapshots.push(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch (error) {
      continue
    }
  }

  return sortSnapshots(snapshots)
}

function writeOutputHtml(outputPath, html) {
  try {
    writeTextIfChanged(outputPath, html)
    lastWrittenOutputPath = outputPath
    return outputPath
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : ''
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      const fallbackDir = process.env.DASHBOARD_OUTPUT_FALLBACK_DIR || os.tmpdir()
      const fallbackPath = path.join(fallbackDir, `dashboard-daily-${Date.now()}.html`)
      writeTextAtomic(fallbackPath, html)
      lastWrittenOutputPath = fallbackPath
      console.warn(`无法写入输出文件：${outputPath}。已改写到临时文件：${fallbackPath}`)
      return fallbackPath
    }

    throw error
  }
}

async function generateDashboardFile({
  // 主生成函数：准备快照 -> 更新本地索引 -> 加载模板 -> 注入运行时 -> 输出 HTML。
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
  const templatePath = resolveDashboardTemplatePath()
  const outputPath = DEFAULT_OUTPUT_PATH
  const snapshotStorePath = DEFAULT_SNAPSHOT_STORE_DIR
  let snapshots
  let source = 'cloud'
  let manifest

  try {
    const cloudbase = resolveCloudbaseSdk()
    const options = resolveCloudbaseOptions()
    const app = cloudbase.init({
      ...options,
      timeout: DEFAULT_SNAPSHOT_READ_TIMEOUT_MS,
    })
    snapshots = await readSnapshotsFromDatabase(app.database())
    manifest = buildSnapshotManifest(snapshots)
  } catch (error) {
    snapshots = await loadEmbeddedSnapshots(snapshotStorePath)
    manifest = buildSnapshotManifest(snapshots)
    source = snapshots.length ? 'local-fallback' : 'cloud-unavailable'
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
  resolveDashboardTemplatePath,
  resolveCloudbaseOptions,
  resolveCloudbaseSdk,
  sortSnapshots,
  writeJsonIfChanged,
  writeLocalSnapshotStore,
  writeOutputHtml,
  writeTextIfChanged,
}





