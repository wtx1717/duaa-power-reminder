import {
  hasAuthenticated,
  loginWithWechat,
  markAuthenticated,
} from '../../services/auth'

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

  async loginAfterPrivacyAuthorization() {
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
      this.setData({
        message: error instanceof Error ? error.message : '登录失败，请重试',
      })
    } finally {
      this.setData({ loading: false })
    }
  },
})
