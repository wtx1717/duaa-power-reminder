const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const ROOT_DIR = path.resolve(__dirname, '..')
const OUTPUT_DIR = path.resolve(ROOT_DIR, 'outputs', 'ops')
const SNAPSHOT_DIR = path.resolve(OUTPUT_DIR, 'snapshots')
const OUTPUT_HTML = path.resolve(OUTPUT_DIR, 'dashboard-daily.html')
const PORT = Number(process.env.DASHBOARD_PREVIEW_PORT || 33123)
const HOST = '127.0.0.1'

let refreshState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'application/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.txt': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

function sendText(res, statusCode, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(text)
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readRefreshSummary() {
  const manifest = readJsonIfExists(path.join(SNAPSHOT_DIR, 'index.json'))
  return {
    manifest,
    outputHtml: fs.existsSync(OUTPUT_HTML),
    snapshotDirExists: fs.existsSync(SNAPSHOT_DIR),
  }
}

function spawnRefreshCommand() {
  const command = process.platform === 'win32'
    ? 'cmd.exe'
    : 'npm'
  const args = process.platform === 'win32'
    ? ['/c', 'npm.cmd', 'run', 'generate:dashboard']
    : ['run', 'generate:dashboard']

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const error = new Error(`generate:dashboard 退出，code=${code} signal=${signal || '-'}`)
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, 'Not Found')
    return
  }

  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  fs.createReadStream(filePath).pipe(res)
}

function resolveSnapshotFile(urlPath) {
  const relative = path.normalize(urlPath.replace(/^\/snapshots\//, ''))
  const target = path.resolve(SNAPSHOT_DIR, relative)
  if (!target.startsWith(SNAPSHOT_DIR)) {
    return null
  }
  return target
}

async function handleRefresh(res) {
  if (refreshState.running) {
    sendJson(res, 409, {
      ok: false,
      error: '刷新任务正在运行',
      running: true,
      ...readRefreshSummary(),
    })
    return
  }

  refreshState.running = true
  refreshState.startedAt = new Date().toISOString()
  refreshState.lastError = null

  try {
    const result = await spawnRefreshCommand()
    const summary = readRefreshSummary()
    refreshState.finishedAt = new Date().toISOString()
    refreshState.lastResult = {
      startedAt: refreshState.startedAt,
      finishedAt: refreshState.finishedAt,
      summary,
    }

    sendJson(res, 200, {
      ok: true,
      startedAt: refreshState.startedAt,
      finishedAt: refreshState.finishedAt,
      ...summary,
      stdout: result.stdout.slice(-6000),
      stderr: result.stderr.slice(-2000),
    })
  } catch (error) {
    refreshState.finishedAt = new Date().toISOString()
    refreshState.lastError = error instanceof Error ? error.message : String(error)

    sendJson(res, 500, {
      ok: false,
      error: refreshState.lastError,
      startedAt: refreshState.startedAt,
      finishedAt: refreshState.finishedAt,
      stdout: error && typeof error.stdout === 'string' ? error.stdout.slice(-6000) : '',
      stderr: error && typeof error.stderr === 'string' ? error.stderr.slice(-6000) : '',
      ...readRefreshSummary(),
    })
  } finally {
    refreshState.running = false
  }
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET'
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
  const pathname = requestUrl.pathname

  if (method === 'OPTIONS') {
    sendText(res, 204, '')
    return
  }

  if (method === 'GET' && pathname === '/') {
    res.writeHead(302, { Location: '/dashboard-daily.html' })
    res.end()
    return
  }

  if (method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, {
      ok: true,
      running: refreshState.running,
      startedAt: refreshState.startedAt,
      finishedAt: refreshState.finishedAt,
      lastError: refreshState.lastError,
      lastResult: refreshState.lastResult,
      ...readRefreshSummary(),
    })
    return
  }

  if (method === 'POST' && pathname === '/api/refresh') {
    void handleRefresh(res)
    return
  }

  if (method === 'GET' && pathname === '/dashboard-daily.html') {
    serveStaticFile(res, OUTPUT_HTML)
    return
  }

  if (method === 'GET' && pathname.startsWith('/snapshots/')) {
    const filePath = resolveSnapshotFile(pathname)
    if (!filePath) {
      sendText(res, 400, 'Bad Request')
      return
    }
    serveStaticFile(res, filePath)
    return
  }

  if (method === 'GET' && pathname.startsWith('/outputs/ops/')) {
    const filePath = path.resolve(ROOT_DIR, pathname.slice(1))
    if (!filePath.startsWith(OUTPUT_DIR)) {
      sendText(res, 400, 'Bad Request')
      return
    }
    serveStaticFile(res, filePath)
    return
  }

  sendText(res, 404, 'Not Found')
})

server.listen(PORT, HOST, () => {
  console.log(`dashboard preview server listening on http://${HOST}:${PORT}`)
})

