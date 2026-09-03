import {
  clearAuthenticated,
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
})
