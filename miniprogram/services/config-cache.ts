// 登录结果和最近一次电量查询结果的本地缓存。
// 缓存的目的不是替代服务器，而是让页面打开时先显示上一次已知状态。
import type {
  LoginResult,
  MeterSnapshot,
  MeterType,
  QueryPowerResult,
  UserPowerConfig,
} from '../types/domain'

const POWER_CONFIG_CACHE_STORAGE_KEY = 'duaa-power-config-cache'

interface CachedLoginResult extends LoginResult {
  cachedAt: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  // unknown 不能直接访问属性；先确认它是对象后，TS 才允许继续缩小类型。
  return Boolean(value) && typeof value === 'object'
}

function isCachedLoginResult(value: unknown): value is CachedLoginResult {
  // 这里只检查缓存最基本的外形，详细字段仍由页面和云函数返回结果保证。
  return isObject(value)
    && typeof value.openid === 'string'
    && typeof value.cachedAt === 'number'
}

export function getCachedLoginResult(): CachedLoginResult | undefined {
  const value = wx.getStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY)

  if (!isCachedLoginResult(value)) {
    return undefined
  }

  return value
}

export function isCachedLoginResultFresh(maxAgeMs: number): boolean {
  // 用当前时间减去写入时间，判断缓存是否仍在允许的有效期内。
  const cached = getCachedLoginResult()
  return Boolean(cached && Date.now() - cached.cachedAt < maxAgeMs)
}

export function setCachedLoginResult(result: LoginResult): LoginResult {
  // 合并缓存时保留较新的电量快照，防止一次较旧的登录响应覆盖刚查到的新数据。
  const mergedResult = mergeCachedMeterSnapshots(result, getCachedLoginResult())
  wx.setStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY, {
    ...mergedResult,
    cachedAt: Date.now(),
  })
  return mergedResult
}

export function setCachedPowerConfig(config: UserPowerConfig): void {
  // 保存配置时只写入用户配置和 openid；电表最新读数由后续查询单独更新。
  wx.setStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY, {
    openid: config.openid,
    config,
    cachedAt: Date.now(),
  })
}

function isIncomingSnapshotNewer(
  incomingQueriedAt: string | undefined,
  currentQueriedAt?: string,
): boolean {
  // 时间字符串可能来自云开发 Date，也可能来自手动构造的数据。
  // 无法解析时选择保守地接受新数据，避免有效查询结果被丢弃。
  if (!incomingQueriedAt) {
    return false
  }

  if (!currentQueriedAt) {
    return true
  }

  const incomingTime = Date.parse(incomingQueriedAt)
  const currentTime = Date.parse(currentQueriedAt)

  if (Number.isNaN(incomingTime) || Number.isNaN(currentTime)) {
    return true
  }

  return incomingTime >= currentTime
}

function getConfiguredMeterId(result: LoginResult, type: MeterType): string | undefined {
  if (!result.config) {
    return undefined
  }

  return type === 'light'
    ? result.config.lightMeterId
    : result.config.acMeterId
}

function shouldPreserveCachedMeter(
  type: MeterType,
  result: LoginResult,
  cachedMeter?: MeterSnapshot,
): boolean {
  // 只有用户仍绑定同一块电表，并且缓存时间不早于服务器返回时间时，才保留缓存。
  if (!cachedMeter || !result.config) {
    return false
  }

  const incomingMeter = result.meters ? result.meters[type] : undefined
  const expectedMeterId = getConfiguredMeterId(result, type) || (incomingMeter && incomingMeter.meterId)

  if (expectedMeterId && cachedMeter.meterId !== expectedMeterId) {
    return false
  }

  return isIncomingSnapshotNewer(
    cachedMeter.lastQueriedAt,
    incomingMeter && incomingMeter.lastQueriedAt,
  )
}

function mergeCachedMeterSnapshots(
  result: LoginResult,
  cached?: CachedLoginResult,
): LoginResult {
  // 不同用户的缓存绝不能互相合并；openid 不一致时直接使用服务器结果。
  if (!cached || cached.openid !== result.openid) {
    return result
  }

  const light = shouldPreserveCachedMeter('light', result, cached.meters && cached.meters.light)
    ? cached.meters && cached.meters.light
    : result.meters && result.meters.light
  const ac = shouldPreserveCachedMeter('ac', result, cached.meters && cached.meters.ac)
    ? cached.meters && cached.meters.ac
    : result.meters && result.meters.ac

  return {
    ...result,
    meters: {
      ...result.meters,
      light,
      ac,
    },
  }
}

export function updateCachedMeterResult(
  type: MeterType,
  result: QueryPowerResult,
): void {
  // 失败结果不覆盖成功快照；这样网络暂时失败时页面仍能显示最后一次有效读数。
  if (!result.ok) {
    return
  }

  const cached = getCachedLoginResult()
  if (!cached) {
    return
  }

  const currentMeter = cached.meters ? cached.meters[type] : undefined
  if (!isIncomingSnapshotNewer(result.queriedAt, currentMeter && currentMeter.lastQueriedAt)) {
    return
  }

  // 展开旧缓存后，只替换对应类型的电表，另一块电表的数据保持不变。
  wx.setStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY, {
    ...cached,
    meters: {
      ...cached.meters,
      [type]: {
        ...(currentMeter || {}),
        meterId: result.meterId,
        type,
        lastRemainingKwh: result.remainingKwh,
        lastQueriedAt: result.queriedAt,
      },
    },
  })
}

export function clearCachedLoginResult(): void {
  wx.removeStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY)
}
