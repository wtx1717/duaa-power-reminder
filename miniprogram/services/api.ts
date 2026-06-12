export interface CloudCallOptions<TPayload> {
  name: string
  data?: TPayload
}

export async function callCloudFunction<TPayload, TResult>(
  options: CloudCallOptions<TPayload>,
): Promise<TResult> {
  const result = await wx.cloud.callFunction({
    name: options.name,
    data: options.data || {},
  })

  return result.result as TResult
}
