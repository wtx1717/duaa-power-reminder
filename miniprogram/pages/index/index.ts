import { hasAuthenticated, loginWithWechat } from '../../services/auth'
import { queryPower } from '../../services/meter'
import type { QueryPowerResult } from '../../types/domain'
import {
  createHomePowerState,
  createMeterView,
  type HomePowerState,
} from '../../utils/power-state'

const QUERY_BUTTON_COOLDOWN_MS = 3000
const QUERY_TOO_FREQUENT_MESSAGE = '操作过于频繁，请稍后再试'

function setGlobalHomePowerState(state: HomePowerState): void {
  const app = getApp<IAppOption>()
  app.globalData.homePowerState = state
}

function getGlobalHomePowerState(): HomePowerState | undefined {
  return getApp<IAppOption>().globalData.homePowerState
}

Page({
  data: {
    openidText: '体验模式',
    isAuthenticated: false,
    lightMeterId: '',
    acMeterId: '',
    lightPower: createMeterView('照明'),
    acPower: createMeterView('空调'),
    loading: true,
    queryingAll: false,
    message: '',
    queryCooldownUntil: 0,
  },

  onLoad() {
    if (!hasAuthenticated()) {
      this.setData({ loading: false })
      return
    }

    this.login()
  },

  onShow() {
    const sharedState = getGlobalHomePowerState()

    if (sharedState) {
      this.setData({
        loading: false,
        queryingAll: false,
        message: '',
        queryCooldownUntil: 0,
        ...sharedState,
      })
      return
    }

    if (!hasAuthenticated()) {
      this.setData({
        loading: false,
        isAuthenticated: false,
        openidText: '体验模式',
      })
      return
    }

    if (!this.data.isAuthenticated && !this.data.loading) {
      this.login()
    }
  },

  async login() {
    this.setData({
      loading: true,
      message: '',
    })

    try {
      const result = await loginWithWechat()
      const config = result.config
      const state = createHomePowerState(
        config
          ? {
              lightMeterId: config.lightMeterId,
              acMeterId: config.acMeterId,
            }
          : undefined,
        result.meters,
        true,
      )

      const app = getApp<IAppOption>()
      app.globalData.openid = result.openid
      setGlobalHomePowerState(state)
      this.setData(state)
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '登录失败，请稍后重试',
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  requireLogin(): boolean {
    if (hasAuthenticated()) {
      return true
    }

    wx.showModal({
      title: '需要登录',
      content: '查询电量需要登录，请前往设置页授权登录。',
      confirmText: '去设置',
      success: (result) => {
        if (result.confirm) {
          wx.switchTab({
            url: '/pages/settings/settings',
          })
        }
      },
    })

    return false
  },

  async onQueryPower() {
    if (!this.requireLogin()) {
      return
    }

    const now = Date.now()
    if (this.data.queryingAll || this.data.queryCooldownUntil > now) {
      return
    }

    const lightMeterId = this.data.lightMeterId.trim()
    const acMeterId = this.data.acMeterId.trim()

    if (!lightMeterId || !acMeterId) {
      this.setData({ message: '请先在设置页填写两块电表号并保存配置' })
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
          meterId: lightMeterId,
          type: 'light',
        }),
        queryPower({
          meterId: acMeterId,
          type: 'ac',
        }),
      ])

      const lightPower = createMeterView('照明', lightMeterId, lightResult)
      const acPower = createMeterView('空调', acMeterId, acResult)
      const currentState = getGlobalHomePowerState() || createHomePowerState(
        { lightMeterId, acMeterId },
        undefined,
        true,
      )

      setGlobalHomePowerState({
        ...currentState,
        lightMeterId,
        acMeterId,
        lightPower,
        acPower,
      })
      this.setData({
        lightPower,
        acPower,
        message: lightResult.ok || acResult.ok
          ? '查询完成'
          : [lightResult, acResult].some(
              (result: QueryPowerResult) => result.error === QUERY_TOO_FREQUENT_MESSAGE,
            )
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
      this.setData({ queryingAll: false })
    }
  },
})
