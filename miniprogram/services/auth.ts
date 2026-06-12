import { callCloudFunction } from './api'
import type { LoginResult } from '../types/domain'

export async function loginWithWechat(): Promise<LoginResult> {
  return callCloudFunction<Record<string, never>, LoginResult>({
    name: 'login',
    data: {},
  })
}
