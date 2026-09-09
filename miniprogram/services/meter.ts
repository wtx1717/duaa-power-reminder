// 电表相关的云函数调用封装。
// 这一层只负责组装云函数名称和参数，不处理页面状态。
import { callCloudFunction } from './api'
import type {
  QueryPowerPayload,
  QueryPowerResult,
  SaveConfigPayload,
  SaveConfigResult,
  ScheduledCheckResult,
  UnbindConfigResult,
} from '../types/domain'

/** 保存或更新当前用户的两块电表及提醒邮箱。 */
export async function savePowerConfig(payload: SaveConfigPayload): Promise<SaveConfigResult> {
  return callCloudFunction<SaveConfigPayload, SaveConfigResult>({
    name: 'saveConfig',
    data: payload,
  })
}

/** 查询指定类型的电表当前电量。 */
export async function queryPower(payload: QueryPowerPayload): Promise<QueryPowerResult> {
  return callCloudFunction<QueryPowerPayload, QueryPowerResult>({
    name: 'queryPower',
    data: payload,
  })
}

/** 手动触发一次定时巡检，主要用于运维或测试。 */
export async function runScheduledCheck(): Promise<ScheduledCheckResult> {
  return callCloudFunction<Record<string, never>, ScheduledCheckResult>({
    name: 'scheduledCheck',
    data: {},
  })
}

/** 删除当前用户配置，并清理不再被其他用户使用的电表。 */
export async function unbindPowerConfig(): Promise<UnbindConfigResult> {
  return callCloudFunction<Record<string, never>, UnbindConfigResult>({
    name: 'unbindConfig',
    data: {},
  })
}
