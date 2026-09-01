import { callCloudFunction } from './api'
import type { LoginResult } from '../types/domain'

export const AUTHENTICATED_STORAGE_KEY = 'duaa-authenticated'

export function clearAuthenticated(): void {
  wx.removeStorageSync(AUTHENTICATED_STORAGE_KEY)
}

export function hasAuthenticated(): boolean {
  return wx.getStorageSync(AUTHENTICATED_STORAGE_KEY) === true
}

export function markAuthenticated(): void {
  wx.setStorageSync(AUTHENTICATED_STORAGE_KEY, true)
}

export async function loginWithWechat(): Promise<LoginResult> {
  return callCloudFunction<Record<string, never>, LoginResult>({
    name: 'login',
    data: {},
  })
}
