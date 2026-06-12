export interface CloudCallOptions<TPayload> {
  name: string
  data?: TPayload
}

export async function callCloudFunction<TPayload, TResult>(
  options: CloudCallOptions<TPayload>,
): Promise<TResult> {
  if (!wx.cloud) {
    throw new Error('当前微信版本不支持云开发')
  }

  const result = await wx.cloud.callFunction({
    name: options.name,
    data: options.data || {},
  })

  return result.result as TResult
}
