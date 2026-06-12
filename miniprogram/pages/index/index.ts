import { loginWithWechat } from '../../services/auth'
import { queryPower, runScheduledCheck, savePowerConfig } from '../../services/meter'
import { requestPowerNotificationSubscribe } from '../../services/notification'
import type { PowerNotificationSubscribeResult } from '../../services/notification'
import type {
  MeterPowerView,
  QueryPowerResult,
  SaveConfigPayload,
  ScheduledCheckResult,
} from '../../types/domain'

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

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function getDefaultNextCheckAt(): Date {
  const date = new Date()
  date.setMinutes(date.getMinutes() + 10)
  date.setSeconds(0, 0)
  return date
}

function toDate(value?: string): Date | undefined {
  if (!value) {
    return undefined
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function toPickerDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function toPickerTime(value: Date): string {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function formatScheduleText(date: string, time: string): string {
  return `${date} ${time}`
}

function parsePickerDateTime(date: string, time: string): Date | undefined {
  const value = new Date(`${date}T${time}:00`)
  return Number.isNaN(value.getTime()) ? undefined : value
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

function formatSubscribeMessage(status: PowerNotificationSubscribeResult): string {
  if (status === 'rejected') {
    return '，已拒绝订阅，本次仅查询电量'
  }

  if (status === 'skipped') {
    return '，订阅授权未完成，本次仅查询电量'
  }

  return ''
}

function formatScheduledCheckMessage(result: ScheduledCheckResult): string {
  if (result.locked) {
    return '定时查询正在执行中，请稍后再试'
  }

  const failed = result.failedNotifications || 0
  const skipped = result.skippedNotifications || 0
  const errorCount = result.errors ? result.errors.length : 0
  const errorText = errorCount > 0 ? `，异常 ${errorCount} 个` : ''
  const lockText = result.lockDisabled ? '（未启用任务锁）' : ''

  return `定时查询完成${lockText}：处理 ${result.checkedMeters} 个电表，发送 ${result.sentNotifications} 条，失败 ${failed} 条，跳过 ${skipped} 条${errorText}`
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
    scheduledChecking: false,
    scheduledDate: toPickerDate(getDefaultNextCheckAt()),
    scheduledTime: toPickerTime(getDefaultNextCheckAt()),
    scheduledCheckText: formatScheduleText(
      toPickerDate(getDefaultNextCheckAt()),
      toPickerTime(getDefaultNextCheckAt()),
    ),
    checkIntervalMinutes: '1440',
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
      const nextCheckAt = toDate(result.meters && result.meters.light
        ? result.meters.light.nextCheckAt
        : undefined) || toDate(result.meters && result.meters.ac
          ? result.meters.ac.nextCheckAt
          : undefined) || getDefaultNextCheckAt()
      const scheduledDate = toPickerDate(nextCheckAt)
      const scheduledTime = toPickerTime(nextCheckAt)
      const checkIntervalMinutes = result.meters && result.meters.light && result.meters.light.checkIntervalMinutes
        ? String(result.meters.light.checkIntervalMinutes)
        : result.meters && result.meters.ac && result.meters.ac.checkIntervalMinutes
          ? String(result.meters.ac.checkIntervalMinutes)
          : this.data.checkIntervalMinutes

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
        scheduledDate,
        scheduledTime,
        scheduledCheckText: formatScheduleText(scheduledDate, scheduledTime),
        checkIntervalMinutes,
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

  onScheduledDateChange(event: InputEvent) {
    const scheduledDate = event.detail.value
    this.setData({
      scheduledDate,
      scheduledCheckText: formatScheduleText(scheduledDate, this.data.scheduledTime),
    })
  },

  onScheduledTimeChange(event: InputEvent) {
    const scheduledTime = event.detail.value
    this.setData({
      scheduledTime,
      scheduledCheckText: formatScheduleText(this.data.scheduledDate, scheduledTime),
    })
  },

  onCheckIntervalInput(event: InputEvent) {
    this.setData({
      checkIntervalMinutes: event.detail.value,
    })
  },

  buildSavePayload(): SaveConfigPayload | undefined {
    const thresholdKwh = Number(this.data.thresholdKwh)
    const nextCheckAt = parsePickerDateTime(this.data.scheduledDate, this.data.scheduledTime)
    const checkIntervalMinutes = Number(this.data.checkIntervalMinutes)
    const payload: SaveConfigPayload = {
      lightMeterId: this.data.lightMeterId.trim(),
      acMeterId: this.data.acMeterId.trim(),
      thresholdKwh,
      reminderEnabled: this.data.reminderEnabled,
      nextCheckAt: nextCheckAt ? nextCheckAt.toISOString() : undefined,
      checkIntervalMinutes,
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

    if (!nextCheckAt) {
      this.setData({ message: '定时查询时间不正确' })
      return undefined
    }

    if (!Number.isFinite(checkIntervalMinutes) || checkIntervalMinutes < 5) {
      this.setData({ message: '查询间隔不能小于 5 分钟' })
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

    const subscribeStatus = await requestPowerNotificationSubscribe()
    const subscribeMessage = formatSubscribeMessage(subscribeStatus)

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
          notificationSubscribeStatus: subscribeStatus,
        }),
        queryPower({
          meterId: payload.acMeterId,
          type: 'ac',
          notificationSubscribeStatus: subscribeStatus,
        }),
      ])

      this.setData({
        lightPower: createMeterView('照明', payload.lightMeterId, lightResult),
        acPower: createMeterView('空调', payload.acMeterId, acResult),
        message: `${lightResult.ok || acResult.ok ? '查询完成' : '两个电表都查询失败'}${subscribeMessage}`,
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

  async onRunScheduledCheck() {
    this.setData({
      scheduledChecking: true,
      message: '',
    })

    try {
      const result = await runScheduledCheck()
      this.setData({
        message: formatScheduledCheckMessage(result),
      })
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '定时查询执行失败，请稍后重试',
      })
    } finally {
      this.setData({
        scheduledChecking: false,
      })
    }
  },

})
