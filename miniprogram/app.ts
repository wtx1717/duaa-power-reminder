// 小程序全局入口。
// 这里负责初始化云开发环境，并记录小程序启动时间。
App<IAppOption>({
  globalData: {},
  onLaunch() {
    // 云开发对象在真机和开发者工具中可能不可用，因此先判断再初始化。
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-d3gx4mdbd073aa68d',
        traceUser: true,
      })
    }

    // logs 是一个简单的本地启动记录数组，日志页面会读取它进行展示。
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)
  },
})
