const githubUrl = 'https://github.com/wtx1717/duaa-power-reminder'
const email = '13100162717@163.com'

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
  },

  onCopyGithub() {
    copyText(githubUrl, '已复制链接')
  },

  onCopyEmail() {
    copyText(email, '已复制邮箱')
  },
})
