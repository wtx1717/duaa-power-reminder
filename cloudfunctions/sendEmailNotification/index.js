// sendEmailNotification 云函数：验证低电量提醒对象并通过 SMTP 发送邮件。
const cloud = require('wx-server-sdk')
const nodemailer = require('nodemailer')

const COLLECTIONS = {
  userConfigs: 'user_configs',
}

const DEFAULT_SMTP_HOST = 'smtp.163.com'
const DEFAULT_SMTP_PORT = 465
const DEFAULT_SMTP_USER = '13100162717@163.com'
const DEFAULT_MAIL_TIME_ZONE = 'Asia/Shanghai'
const DEFAULT_REMINDER_THRESHOLD_KWH = 20
const RECHARGE_URL = 'http://shsd.buaa.edu.cn/BuaaPay'

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

function normalizeEmail(value) {
  // 邮箱统一清理后再与 user_configs 中的配置比较。
  return String(value || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function normalizeType(value) {
  return value === 'ac' ? 'ac' : value === 'light' ? 'light' : undefined
}

function parseFiniteNumber(value) {
  // Number('') 等特殊输入可能得到 0，因此还要用 isFinite 判断是否是真正数字。
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function asDate(value) {
  // 兼容 Date、云开发日期对象和字符串日期。
  if (!value) {
    return new Date()
  }

  if (value instanceof Date) {
    return value
  }

  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate()
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function formatDateTime(value) {
  // 优先使用 Intl 按配置时区格式化；运行环境不支持时回退到北京时间计算。
  const date = asDate(value)
  const timeZone = process.env.MAIL_TIME_ZONE || DEFAULT_MAIL_TIME_ZONE

  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const values = {}

    for (const part of parts) {
      if (part.type !== 'literal') {
        values[part.type] = part.value
      }
    }

    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`
  } catch (_error) {
    const fallback = new Date(date.getTime() + 8 * 60 * 60 * 1000)
    const pad = (value) => String(value).padStart(2, '0')
    return `${fallback.getUTCFullYear()}-${pad(fallback.getUTCMonth() + 1)}-${pad(fallback.getUTCDate())} ${pad(fallback.getUTCHours())}:${pad(fallback.getUTCMinutes())}`
  }
}

function escapeHtml(value) {
  // 邮件 HTML 中的用户/页面数据必须转义，避免破坏邮件结构。
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getMeterTypeLabel(type) {
  return type === 'ac' ? '空调电表' : '照明电表'
}

function getSmtpConfig() {
  // SMTP 密码只从环境变量读取，源码不保存授权码。
  const host = process.env.SMTP_HOST || DEFAULT_SMTP_HOST
  const port = Number(process.env.SMTP_PORT || DEFAULT_SMTP_PORT)
  const secureValue = process.env.SMTP_SECURE
  const secure = secureValue === undefined ? true : secureValue !== 'false'
  const user = process.env.SMTP_USER || DEFAULT_SMTP_USER
  const pass = process.env.SMTP_PASS
  const from = process.env.SMTP_FROM || `duaa 宿舍电量提醒 <${user}>`

  if (!host || !Number.isFinite(port) || !user || !pass) {
    return {
      ok: false,
      error: 'Missing SMTP configuration',
    }
  }

  return {
    ok: true,
    host,
    port,
    secure,
    user,
    pass,
    from,
  }
}

function validateInput(event) {
  // 这里返回 skipped 而不是抛错，因为“无需发送”是正常业务分支。
  const openid = String(event.openid || '').trim()
  const email = normalizeEmail(event.email)
  const meterId = String(event.meterId || '').trim()
  const type = normalizeType(event.type)
  const remainingKwh = parseFiniteNumber(event.remainingKwh)
  const thresholdKwh = DEFAULT_REMINDER_THRESHOLD_KWH
  const source = event.source === 'scheduledCheck' ? 'scheduledCheck' : 'queryPower'

  if (!openid) {
    return { ok: false, status: 'skipped', error: 'Missing openid' }
  }

  if (!email || !isValidEmail(email)) {
    return { ok: false, status: 'skipped', error: 'Invalid email' }
  }

  if (!meterId) {
    return { ok: false, status: 'skipped', error: 'Missing meterId' }
  }

  if (!type) {
    return { ok: false, status: 'skipped', error: 'Invalid meter type' }
  }

  if (remainingKwh === undefined) {
    return { ok: false, status: 'skipped', error: 'Invalid remaining kWh' }
  }

  if (remainingKwh > thresholdKwh) {
    return { ok: false, status: 'skipped', error: 'Remaining kWh is above threshold' }
  }

  return {
    ok: true,
    openid,
    email,
    meterId,
    type,
    remainingKwh,
    thresholdKwh,
    queriedAt: asDate(event.queriedAt),
    address: String(event.address || '').trim(),
    source,
  }
}

async function assertConfiguredRecipient(db, input) {
  // 再次确认用户仍绑定该邮箱和电表，防止旧任务给已解绑用户发邮件。
  const result = await db.collection(COLLECTIONS.userConfigs).where({
    openid: input.openid,
    email: input.email,
    reminderEnabled: true,
  }).get()
  const config = result.data[0]

  if (!config) {
    return {
      ok: false,
      status: 'skipped',
      error: 'Email is not configured for this user',
    }
  }

  const expectedMeterId = input.type === 'ac' ? config.acMeterId : config.lightMeterId
  if (expectedMeterId !== input.meterId) {
    return {
      ok: false,
      status: 'skipped',
      error: 'Meter is not configured for this user',
    }
  }

  return { ok: true }
}

function createMail(input) {
  // 同时生成纯文本和 HTML 两种正文，兼容不同邮件客户端。
  const typeLabel = getMeterTypeLabel(input.type)
  const timeText = formatDateTime(input.queriedAt)
  const addressText = input.address || '未解析到公寓地址'
  const subject = `低电量提醒：${typeLabel}剩余 ${input.remainingKwh} kWh`
  const lines = [
    '宿舍电量已达到提醒阈值，请及时充值。',
    '',
    `电表类型：${typeLabel}`,
    `电表号：${input.meterId}`,
    `剩余电量：${input.remainingKwh} kWh`,
    `提醒阈值：${input.thresholdKwh} kWh`,
    `查询时间：${timeText}`,
    `公寓地址：${addressText}`,
    '',
    '立即充值：',
    RECHARGE_URL,
    '',
    '如需解绑电表或关闭提醒，请进入小程序页面操作。',
    '',
    'duaa 宿舍电量提醒',
  ]
  const html = `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.6;color:#222;">
      <p>宿舍电量已达到提醒阈值，请及时充值。</p>
      <ul>
        <li>电表类型：${escapeHtml(typeLabel)}</li>
        <li>电表号：${escapeHtml(input.meterId)}</li>
        <li>剩余电量：${escapeHtml(input.remainingKwh)} kWh</li>
        <li>提醒阈值：${escapeHtml(input.thresholdKwh)} kWh</li>
        <li>查询时间：${escapeHtml(timeText)}</li>
        <li>公寓地址：${escapeHtml(addressText)}</li>
      </ul>
      <p>如需充值，请点击下方按钮进入充值页面：</p>
      <p>
        <a
          href="${RECHARGE_URL}"
          style="display:inline-block;padding:10px 18px;background-color:#1677ff;color:#fff;text-decoration:none;border-radius:4px;white-space:nowrap;"
        >立即充值</a>
      </p>
      <p>如需解绑电表或关闭提醒，请进入小程序页面操作。</p>
      <p>duaa 宿舍电量提醒</p>
    </div>
  `

  return {
    subject,
    text: lines.join('\n'),
    html,
  }
}

async function sendMail(input) {
  // 创建一次 SMTP transporter 并发送邮件；配置缺失时返回 failed。
  const smtp = getSmtpConfig()
  if (!smtp.ok) {
    return {
      status: 'failed',
      error: smtp.error,
    }
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  })
  const mail = createMail(input)

  await transporter.sendMail({
    from: smtp.from,
    to: input.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  })

  return {
    status: 'sent',
  }
}

exports.main = async (event) => {
  // 主流程：校验输入 -> 校验当前调用身份 -> 校验用户配置 -> 发送邮件。
  const input = validateInput(event || {})

  if (!input.ok) {
    return {
      status: input.status,
      error: input.error,
    }
  }

  const { OPENID } = cloud.getWXContext()
  if (OPENID && OPENID !== input.openid) {
    return {
      status: 'skipped',
      error: 'Openid does not match current caller',
    }
  }

  try {
    const db = cloud.database()
    const recipient = await assertConfiguredRecipient(db, input)

    if (!recipient.ok) {
      return {
        status: recipient.status,
        error: recipient.error,
      }
    }

    return await sendMail(input)
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
