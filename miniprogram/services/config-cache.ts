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
  return Boolean(value) && typeof value === 'object'
}

function isCachedLoginResult(value: unknown): value is CachedLoginResult {
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
  const cached = getCachedLoginResult()
  return Boolean(cached && Date.now() - cached.cachedAt < maxAgeMs)
}

export function setCachedLoginResult(result: LoginResult): LoginResult {
  const mergedResult = mergeCachedMeterSnapshots(result, getCachedLoginResult())
  wx.setStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY, {
    ...mergedResult,
    cachedAt: Date.now(),
  })
  return mergedResult
}

export function setCachedPowerConfig(config: UserPowerConfig): void {
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
