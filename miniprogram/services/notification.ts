export type PowerNotificationSubscribeResult = 'accepted' | 'rejected' | 'skipped'

export const LOW_POWER_TEMPLATE_ID = '6PcRlFLgfDTAFnepb7jfsj1K-w7jG6oZsqbyXZMgdp4'

export async function requestPowerNotificationSubscribe(): Promise<PowerNotificationSubscribeResult> {
  if (!wx.requestSubscribeMessage) {
    return 'skipped'
  }

  try {
    const result = await wx.requestSubscribeMessage({
      tmplIds: [LOW_POWER_TEMPLATE_ID],
    })
    const status = result[LOW_POWER_TEMPLATE_ID]

    return status === 'accept' ? 'accepted' : 'rejected'
  } catch (_error) {
    return 'skipped'
  }
}
