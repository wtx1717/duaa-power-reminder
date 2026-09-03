const githubUrl = 'https://github.com/wtx1717/duaa-power-reminder'
const email = '13100162717@163.com'
const appreciationCodeUrl = '/assets/appreciation-code.jpg'

function copyText(data: string, title: string) {
  wx.setClipboardData({
    data,
    success() {
      wx.showToast({
        title,
        icon: 'success',
      })
    },
  })
}

Page({
  data: {
    githubUrl,
    email,
    appreciationCodeUrl,
    showAppreciationCode: false,
  },

  onCopyGithub() {
    copyText(githubUrl, '已复制链接')
  },

  onCopyEmail() {
    copyText(email, '已复制邮箱')
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
