// 登录相关服务。
// 微信身份由云函数根据调用上下文识别，小程序只保存“已登录”标记和缓存结果。
import { callCloudFunction } from './api'
import { clearCachedLoginResult, setCachedLoginResult } from './config-cache'
import type { LoginResult } from '../types/domain'

export const AUTHENTICATED_STORAGE_KEY = 'duaa-authenticated'

export function clearAuthenticated(): void {
  // 退出登录时同时清理登录标记和配置缓存，避免旧用户信息继续显示。
  wx.removeStorageSync(AUTHENTICATED_STORAGE_KEY)
  clearCachedLoginResult()
}

export function hasAuthenticated(): boolean {
  // 本地标记只表示用户完成过授权；真正的身份仍由云函数确认。
  return wx.getStorageSync(AUTHENTICATED_STORAGE_KEY) === true
}

export function markAuthenticated(): void {
  // 同步写入布尔值，后续页面可以快速判断是否显示登录状态。
  wx.setStorageSync(AUTHENTICATED_STORAGE_KEY, true)
}

/** 调用 login 云函数，并把最新结果写入本地缓存。 */
export async function loginWithWechat(): Promise<LoginResult> {
  const result = await callCloudFunction<Record<string, never>, LoginResult>({
    name: 'login',
    data: {},
  })
  return setCachedLoginResult(result)
}
