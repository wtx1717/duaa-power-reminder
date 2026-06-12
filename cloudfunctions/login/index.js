const cloud = require('wx-server-sdk')

const COLLECTIONS = {
  userConfigs: 'user_configs',
  meters: 'meters',
}

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

async function getMeterById(db, meterId) {
  if (!meterId) {
    return undefined
  }

  const result = await db.collection(COLLECTIONS.meters).where({ meterId }).get()
  return result.data[0]
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    throw new Error('无法获取微信用户 openid')
  }

  const db = cloud.database()
  const result = await db.collection(COLLECTIONS.userConfigs).where({
    openid: OPENID,
  }).get()
  const config = result.data[0]

  return {
    openid: OPENID,
    config,
    meters: {
      light: await getMeterById(db, config && config.lightMeterId),
      ac: await getMeterById(db, config && config.acMeterId),
    },
  }
}
