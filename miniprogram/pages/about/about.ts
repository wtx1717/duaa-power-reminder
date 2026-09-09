// 关于页面：展示项目链接、联系邮箱和赞赏码。
import { createShareAppMessage, createShareTimeline } from '../../utils/share'

const githubUrl = 'https://github.com/wtx1717/duaa-power-reminder'
const email = '13100162717@163.com'
const appreciationCodeUrl = '/assets/appreciation-code.jpg'

Page({
  data: {
    githubUrl,
    email,
    appreciationCodeUrl,
    showAppreciationCode: false,
  },

  onShowAppreciationCode() {
    this.setData({ showAppreciationCode: true })
  },

  onHideAppreciationCode() {
    this.setData({ showAppreciationCode: false })
  },

  onPreviewAppreciationCode() {
    // previewImage 使用数组接口，即使当前只有一张图片也要传数组。
    wx.previewImage({
      urls: [appreciationCodeUrl],
      current: appreciationCodeUrl,
    })
  },

  onShareAppMessage() {
    return createShareAppMessage()
  },

  onShareTimeline() {
    return createShareTimeline()
  },

  noop() {},
})
