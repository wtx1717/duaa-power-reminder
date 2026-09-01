import { callCloudFunction } from './api'
import type {
  QueryPowerPayload,
  QueryPowerResult,
  SaveConfigPayload,
  SaveConfigResult,
  ScheduledCheckResult,
  UnbindConfigResult,
} from '../types/domain'

export async function savePowerConfig(payload: SaveConfigPayload): Promise<SaveConfigResult> {
  return callCloudFunction<SaveConfigPayload, SaveConfigResult>({
    name: 'saveConfig',
    data: payload,
  })
}

export async function queryPower(payload: QueryPowerPayload): Promise<QueryPowerResult> {
  return callCloudFunction<QueryPowerPayload, QueryPowerResult>({
    name: 'queryPower',
    data: payload,
  })
}

export async function runScheduledCheck(): Promise<ScheduledCheckResult> {
  return callCloudFunction<Record<string, never>, ScheduledCheckResult>({
    name: 'scheduledCheck',
    data: {},
  })
}

export async function unbindPowerConfig(): Promise<UnbindConfigResult> {
  return callCloudFunction<Record<string, never>, UnbindConfigResult>({
    name: 'unbindConfig',
    data: {},
  })
}
