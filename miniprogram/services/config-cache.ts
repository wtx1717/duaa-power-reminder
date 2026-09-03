import type { LoginResult, UserPowerConfig } from '../types/domain'

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

export function setCachedLoginResult(result: LoginResult): void {
  wx.setStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY, {
    ...result,
    cachedAt: Date.now(),
  })
}

export function setCachedPowerConfig(config: UserPowerConfig): void {
  wx.setStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY, {
    openid: config.openid,
    config,
    cachedAt: Date.now(),
  })
}

export function clearCachedLoginResult(): void {
  wx.removeStorageSync(POWER_CONFIG_CACHE_STORAGE_KEY)
}
