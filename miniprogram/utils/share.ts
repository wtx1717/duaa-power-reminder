// 分享配置集中在这里，页面只需要调用两个工厂函数。
const SHARE_TITLE = 'duaa 宿舍电量提醒'
const SHARE_DESCRIPTION = '宿舍电量查询、绑定和低电量提醒小程序'
const SHARE_PATH = '/pages/index/index'
const SHARE_IMAGE_URL = '/assets/login-logo.jpg'

/** 创建转发给好友时使用的分享对象。 */
export function createShareAppMessage() {
  return {
    title: SHARE_TITLE,
    path: SHARE_PATH,
    imageUrl: SHARE_IMAGE_URL,
  }
}

/** 创建分享到朋友圈时使用的分享对象。 */
export function createShareTimeline() {
  return {
    title: SHARE_DESCRIPTION,
    query: '',
    imageUrl: SHARE_IMAGE_URL,
  }
}
