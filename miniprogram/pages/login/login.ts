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
    wx.redirectTo({
      url: '/pages/index/index',
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

      wx.redirectTo({
        url: '/pages/index/index',
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
