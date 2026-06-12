import type { NotificationRecord, UserConfig } from './types'

export interface SendLowPowerNotificationInput {
  config: UserConfig
  meterId: string
  remainingKwh: number
  thresholdKwh: number
}

export async function sendLowPowerNotification(
  _input: SendLowPowerNotificationInput,
): Promise<Pick<NotificationRecord, 'status' | 'error'>> {
  // TODO: Send WeChat subscribe message after template id and consent flow are configured.
  return {
    status: 'skipped',
    error: 'Notification sender is not implemented',
  }
}
