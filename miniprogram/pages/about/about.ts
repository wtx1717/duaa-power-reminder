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
    wx.previewImage({
      urls: [appreciationCodeUrl],
      current: appreciationCodeUrl,
    })
  },

  noop() {},
})
