// 登录页：先完成隐私协议确认，再调用云函数建立登录状态。
import {
  clearAuthenticated,
  hasAuthenticated,
  loginWithWechat,
  markAuthenticated,
} from '../../services/auth'
import { createShareAppMessage, createShareTimeline } from '../../utils/share'

type CheckboxChangeEvent = {
  detail: {
    value: string[]
  }
}

Page({
  data: {
    loading: false,
    message: '',
    privacyAgreed: false,
    redirecting: false,
  },

  onLoad() {
    this.redirectIfAuthenticated()
  },

  onShow() {
    this.redirectIfAuthenticated()
  },

  redirectIfAuthenticated() {
    // 已经授权过的用户不需要重复登录，直接回到设置页。
    if (!hasAuthenticated() || this.data.redirecting) {
      return
    }

    this.setData({ redirecting: true })
    wx.switchTab({
      url: '/pages/settings/settings',
    })
  },

  onPrivacyChange(event: CheckboxChangeEvent) {
    this.setData({
      privacyAgreed: event.detail.value.indexOf('privacy') !== -1,
      message: '',
    })
  },

  async onAuthorizeLogin() {
    // 未完成隐私勾选时，不调用微信授权接口。
    if (this.data.loading) {
      return
    }

    if (!this.data.privacyAgreed) {
      this.setData({ message: '请先勾选隐私政策' })
      return
    }

    await this.loginAfterPrivacyAuthorization()
  },

  async onPrivacyAuthorized() {
    await this.loginAfterPrivacyAuthorization()
  },

  onOpenPrivacyContract() {
    wx.openPrivacyContract({
      fail: () => {
        this.setData({
          message: '当前环境不支持打开隐私协议，请在微信真机或更新基础库后重试。',
        })
      },
    })
  },

  async loginAfterPrivacyAuthorization() {
    // 登录成功后同时写入本地标记；失败时清除标记，避免出现“假登录”状态。
    this.setData({
      loading: true,
      message: '',
    })

    try {
      await loginWithWechat()
      markAuthenticated()

      wx.switchTab({
        url: '/pages/settings/settings',
      })
    } catch (error) {
      clearAuthenticated()
      this.setData({
        message: error instanceof Error ? error.message : '登录失败，请重试',
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  onShareAppMessage() {
    return createShareAppMessage()
  },

  onShareTimeline() {
    return createShareTimeline()
  },
})
