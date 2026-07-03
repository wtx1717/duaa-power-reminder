export type PowerNotificationSubscribeResult = 'accepted' | 'rejected' | 'skipped'

export const LOW_POWER_TEMPLATE_ID = '6PcRlFLgfDTAFnepb7jfsj1K-w7jG6oZsqbyXZMgdp4'

export async function requestPowerNotificationSubscribe(): Promise<PowerNotificationSubscribeResult> {
  return 'skipped'
}
