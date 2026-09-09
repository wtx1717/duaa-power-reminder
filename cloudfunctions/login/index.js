// login 云函数：读取当前微信用户的 openid、配置和两块电表的最新状态。
// 云函数由微信以 CommonJS 入口 index.js 加载。
const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

async function getMeterById(db, meterId) {
  // 没有绑定电表时不查询数据库；undefined 会被小程序理解为“尚未配置”。
  if (!meterId) {
    return undefined
  }

  const result = await db.collection(COLLECTIONS.meters).where({ meterId }).get()
  return result.data[0]
}

function toPublicConfig(config) {
  // 只挑选客户端需要的字段，避免把服务端内部字段返回给小程序。
  if (!config) {
    return undefined
  }

  return {
    openid: config.openid,
    lightMeterId: config.lightMeterId,
    acMeterId: config.acMeterId,
    email: config.email,
    reminderEnabled: config.reminderEnabled,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }
}

exports.main = async () => {
  // OPENID 来自微信调用上下文，不能使用客户端传入的身份字段。
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  const db = cloud.database()
  const result = await db.collection(COLLECTIONS.userConfigs).where({
    openid: OPENID,
  }).get()
  const config = toPublicConfig(result.data[0])

  return {
    openid: OPENID,
    config,
    meters: {
      light: await getMeterById(db, config && config.lightMeterId),
      ac: await getMeterById(db, config && config.acMeterId),
    },
  }
}
