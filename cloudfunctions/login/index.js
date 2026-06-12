const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  userConfigs: 'user_configs',
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  const db = cloud.database()
  const result = await db.collection(COLLECTIONS.userConfigs).where({
    openid: OPENID,
  }).get()

  return {
    openid: OPENID,
    config: result.data[0],
  }
}
