import { clearAuthenticated, hasAuthenticated, loginWithWechat } from '../../services/auth'
import { queryPower, savePowerConfig, unbindPowerConfig } from '../../services/meter'
import type {
  MeterPowerView,
  QueryPowerResult,
  SaveConfigPayload,
  UnbindConfigResult,
} from '../../types/domain'

type InputEvent = {
  detail: {
    value: string
  }
}

const QUERY_BUTTON_COOLDOWN_MS = 3000
const QUERY_TOO_FREQUENT_MESSAGE = '操作过于频繁，请稍后再试'

// function maskOpenid(openid: string): string {
//   if (openid.length <= 8) {
//     return openid
//   }

//   return `${openid.slice(0, 4)}****${openid.slice(-4)}`
// }

function createMeterView(
  label: string,
  meterId = '',
  result?: QueryPowerResult,
  loading = false,
): MeterPowerView {
  return {
    label,
    meterId,
    loading,
    displayText: result ? formatPowerResult(result) : undefined,
    result,
  }
}

function formatPowerResult(result: QueryPowerResult): string {
  if (!result.ok) {
    return result.error || '查询失败'
  }

  const remaining = result.remainingKwh === undefined
    ? '未知'
    : `${result.remainingKwh} kWh`
  const cutoff = result.cutoffTime ? `， ${result.cutoffTime}` : ''
  return `剩余 ${remaining}${cutoff}`
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function showConfirmModal(content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '确认解绑',
      content,
      confirmText: '继续解绑',
      confirmColor: '#b5452f',
      success(result) {
        resolve(result.confirm)
      },
      fail() {
        resolve(false)
      },
    })
  })
}

function resetUnboundState() {
  return {
    openid: '',
    openidText: '未登录',
    lightMeterId: '',
    acMeterId: '',
    email: '',
    message: '',
    lightPower: createMeterView('照明'),
    acPower: createMeterView('空调'),
    redirectingToLogin: true,
    queryCooldownUntil: 0,
  }
}

function formatUnbindError(error: unknown): string {
  let message = ''

  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === 'string') {
    message = error
  } else if (error && typeof error === 'object') {
    const value = error as {
      errMsg?: unknown
      message?: unknown
      error?: unknown
    }
    const details = [value.errMsg, value.message, value.error]
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
    message = details[0] || ''
  }

  if (!message) {
    return '云函数返回未知错误'
  }

  if (/无法获取当前用户身份/.test(message)) {
    return '无法获取当前用户身份'
  }

  if (/查询用户配置失败/.test(message)) {
    return message
  }

  if (/删除用户配置失败/.test(message)) {
    return message
  }

  if (/调度任务处理失败/.test(message)) {
    return message
  }

  if (/电表清理失败|查询电表失败|查询其他用户绑定失败/.test(message)) {
    return message
  }

  if (/request|timeout|network|fail|interrupted|ERR_/i.test(message)) {
    return '网络异常，请稍后重试'
  }

  return `云函数返回未知错误：${message}`
}

Page({
  data: {
    openid: '',
    openidText: '未登录',
    lightMeterId: '',
    acMeterId: '',
    email: '',
    loading: true,
    saving: false,
    queryingAll: false,
    message: '',
    lightPower: createMeterView('照明'),
    acPower: createMeterView('空调'),
    redirectingToLogin: false,
    queryCooldownUntil: 0,
  },

  async onLoad() {
    if (!hasAuthenticated()) {
      this.setData({ redirectingToLogin: true })
      wx.redirectTo({
        url: '/pages/login/login',
      })
      return
    }

    await this.login()
  },

  onShow() {
    if (hasAuthenticated() || this.data.redirectingToLogin) {
      return
    }

    this.setData({ redirectingToLogin: true })
    wx.redirectTo({
      url: '/pages/login/login',
    })
  },

  async login() {
    this.setData({
      loading: true,
      message: '',
    })

    try {
      const result = await loginWithWechat()
      const app = getApp<IAppOption>()
      app.globalData.openid = result.openid
      const config = result.config
      const lightMeterId = config ? config.lightMeterId : ''
      const acMeterId = config ? config.acMeterId : ''
      const email = config && config.email ? config.email : ''

      this.setData({
        openid: result.openid,
        openidText: `已登录 `,
        lightMeterId,
        acMeterId,
        email,
        lightPower: createMeterView('照明', lightMeterId),
        acPower: createMeterView('空调', acMeterId),
      })
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '登录失败，请稍后重试',
      })
    } finally {
      this.setData({
        loading: false,
      })
    }
  },

  onLightMeterInput(event: InputEvent) {
    const lightMeterId = event.detail.value.trim()
    this.setData({
      lightMeterId,
      lightPower: createMeterView('照明', lightMeterId),
    })
  },

  onAcMeterInput(event: InputEvent) {
    const acMeterId = event.detail.value.trim()
    this.setData({
      acMeterId,
      acPower: createMeterView('空调', acMeterId),
    })
  },

  onEmailInput(event: InputEvent) {
    this.setData({
      email: event.detail.value.trim(),
    })
  },

  buildSavePayload(silent = false): SaveConfigPayload | undefined {
    const payload: SaveConfigPayload = {
      lightMeterId: this.data.lightMeterId.trim(),
      acMeterId: this.data.acMeterId.trim(),
      email: this.data.email.trim(),
      reminderEnabled: true,
    }

    if (!payload.lightMeterId) {
      if (!silent) {
        this.setData({ message: '请填写宿舍照明电表号' })
      }
      return undefined
    }

    if (!payload.acMeterId) {
      if (!silent) {
        this.setData({ message: '请填写宿舍空调电表号' })
      }
      return undefined
    }

    if (payload.lightMeterId === payload.acMeterId) {
      if (!silent) {
        this.setData({ message: '照明电表号和空调电表号不能相同' })
      }
      return undefined
    }

    if (!payload.email) {
      if (!silent) {
        this.setData({ message: '请填写提醒邮箱' })
      }
      return undefined
    }

    if (!isValidEmail(payload.email)) {
      if (!silent) {
        this.setData({ message: '提醒邮箱格式不正确' })
      }
      return undefined
    }

    return payload
  },

  async onSaveConfig() {
    const initialPayload = this.buildSavePayload()

    if (!initialPayload) {
      return
    }

    this.setData({
      saving: true,
      message: '',
    })

    try {
      const payload = this.buildSavePayload(false)

      if (!payload) {
        return
      }

      const result = await savePowerConfig(payload)

      if (!result.ok) {
        throw new Error(result.error || '保存失败，请稍后重试')
      }

      this.setData({
        message: '配置已保存，低电量提醒将发送到邮箱',
        lightPower: createMeterView('照明', payload.lightMeterId),
        acPower: createMeterView('空调', payload.acMeterId),
      })

      wx.showToast({
        title: '已保存',
        icon: 'success',
      })
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '保存失败，请稍后重试',
      })
    } finally {
      this.setData({
        saving: false,
      })
    }
  },

  async onQueryPower() {
    const now = Date.now()

    if (this.data.queryingAll || this.data.queryCooldownUntil > now) {
      return
    }

    const payload = this.buildSavePayload()

    if (!payload) {
      return
    }

    this.setData({
      queryingAll: true,
      queryCooldownUntil: now + QUERY_BUTTON_COOLDOWN_MS,
      message: '',
      'lightPower.loading': true,
      'acPower.loading': true,
    })

    try {
      const [lightResult, acResult] = await Promise.all([
        queryPower({
          meterId: payload.lightMeterId,
          type: 'light',
        }),
        queryPower({
          meterId: payload.acMeterId,
          type: 'ac',
        }),
      ])

      const rateLimitedResult = [lightResult, acResult].find(
        (result) => result.error === QUERY_TOO_FREQUENT_MESSAGE,
      )

      this.setData({
        lightPower: createMeterView('照明', payload.lightMeterId, lightResult),
        acPower: createMeterView('空调', payload.acMeterId, acResult),
        message: lightResult.ok || acResult.ok
          ? '查询完成'
          : rateLimitedResult
            ? QUERY_TOO_FREQUENT_MESSAGE
            : '两个电表都查询失败',
      })
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '查询失败，请稍后重试',
        'lightPower.loading': false,
        'acPower.loading': false,
      })
    } finally {
      this.setData({
        queryingAll: false,
      })
    }
  },

  async onUnbindAndLogout() {
    if (this.data.loading || this.data.saving || this.data.queryingAll) {
      return
    }

    const confirmed = await showConfirmModal(
      '解绑后将删除当前电表和邮箱配置，关闭低电量提醒，并退出当前账号。历史查询记录和提醒记录会保留。确定继续吗？',
    )

    if (!confirmed) {
      return
    }

    this.setData({
      loading: true,
      message: '',
    })

    try {
      const result: UnbindConfigResult = await unbindPowerConfig()

      if (!result || !result.ok) {
        throw new Error(result && result.error ? result.error : '云函数返回未知错误')
      }

      const app = getApp<IAppOption>()
      app.globalData.openid = undefined
      clearAuthenticated()
      this.setData(resetUnboundState())

      wx.showToast({
        title: '解绑成功',
        icon: 'success',
      })

      wx.reLaunch({
        url: '/pages/login/login',
      })
    } catch (error) {
      this.setData({
        loading: false,
        message: formatUnbindError(error),
      })
    }
  },
})
