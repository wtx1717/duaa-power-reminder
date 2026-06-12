import { loginWithWechat } from '../../services/auth'
import { queryPower, savePowerConfig } from '../../services/meter'
import type { MeterPowerView, QueryPowerResult, SaveConfigPayload } from '../../types/domain'

type InputEvent = {
  detail: {
    value: string
  }
}

type SwitchEvent = {
  detail: {
    value: boolean
  }
}

function maskOpenid(openid: string): string {
  if (openid.length <= 8) {
    return openid
  }

  return `${openid.slice(0, 4)}****${openid.slice(-4)}`
}

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
  const cutoff = result.cutoffTime ? `，截止 ${result.cutoffTime}` : ''
  return `剩余 ${remaining}${cutoff}`
}

Page({
  data: {
    openid: '',
    openidText: '未登录',
    lightMeterId: '',
    acMeterId: '',
    thresholdKwh: '20',
    reminderEnabled: true,
    loading: true,
    saving: false,
    queryingAll: false,
    message: '',
    lightPower: createMeterView('照明'),
    acPower: createMeterView('空调'),
  },

  async onLoad() {
    await this.login()
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

      this.setData({
        openid: result.openid,
        openidText: `已登录 ${maskOpenid(result.openid)}`,
        lightMeterId,
        acMeterId,
        thresholdKwh: config && config.thresholdKwh
          ? String(config.thresholdKwh)
          : this.data.thresholdKwh,
        reminderEnabled: config && config.reminderEnabled !== undefined
          ? config.reminderEnabled
          : true,
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

  onThresholdInput(event: InputEvent) {
    this.setData({
      thresholdKwh: event.detail.value,
    })
  },

  onReminderSwitch(event: SwitchEvent) {
    this.setData({
      reminderEnabled: event.detail.value,
    })
  },

  buildSavePayload(): SaveConfigPayload | undefined {
    const thresholdKwh = Number(this.data.thresholdKwh)
    const payload: SaveConfigPayload = {
      lightMeterId: this.data.lightMeterId.trim(),
      acMeterId: this.data.acMeterId.trim(),
      thresholdKwh,
      reminderEnabled: this.data.reminderEnabled,
    }

    if (!payload.lightMeterId) {
      this.setData({ message: '请填写宿舍照明电表号' })
      return undefined
    }

    if (!payload.acMeterId) {
      this.setData({ message: '请填写宿舍空调电表号' })
      return undefined
    }

    if (payload.lightMeterId === payload.acMeterId) {
      this.setData({ message: '照明电表号和空调电表号不能相同' })
      return undefined
    }

    if (!Number.isFinite(payload.thresholdKwh) || payload.thresholdKwh <= 0) {
      this.setData({ message: '提醒阈值必须大于 0' })
      return undefined
    }

    return payload
  },

  async onSaveConfig() {
    const payload = this.buildSavePayload()

    if (!payload) {
      return
    }

    this.setData({
      saving: true,
      message: '',
    })

    try {
      const result = await savePowerConfig(payload)

      if (!result.ok) {
        throw new Error(result.error || '保存失败，请稍后重试')
      }

      this.setData({
        message: '配置已保存',
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
    const payload = this.buildSavePayload()

    if (!payload) {
      return
    }

    this.setData({
      queryingAll: true,
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

      this.setData({
        lightPower: createMeterView('照明', payload.lightMeterId, lightResult),
        acPower: createMeterView('空调', payload.acMeterId, acResult),
        message: lightResult.ok || acResult.ok ? '查询完成' : '两个电表都查询失败',
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

})
