import { callCloudFunction } from './api'
import { clearCachedLoginResult, setCachedLoginResult } from './config-cache'
import type { LoginResult } from '../types/domain'

export const AUTHENTICATED_STORAGE_KEY = 'duaa-authenticated'

export function clearAuthenticated(): void {
  wx.removeStorageSync(AUTHENTICATED_STORAGE_KEY)
  clearCachedLoginResult()
}

export function hasAuthenticated(): boolean {
  return wx.getStorageSync(AUTHENTICATED_STORAGE_KEY) === true
}

export function markAuthenticated(): void {
  wx.setStorageSync(AUTHENTICATED_STORAGE_KEY, true)
}

export async function loginWithWechat(): Promise<LoginResult> {
  const result = await callCloudFunction<Record<string, never>, LoginResult>({
    name: 'login',
    data: {},
  })
  return setCachedLoginResult(result)
}
