// 小程序调用云函数的统一入口。
// 页面不直接操作 wx.cloud，这样云函数调用格式只需要在这里维护。
export interface CloudCallOptions<TPayload> {
  name: string
  data?: TPayload
}

export async function callCloudFunction<TPayload, TResult>(
  options: CloudCallOptions<TPayload>,
): Promise<TResult> {
  // Promise 是“未来某个时间才会得到结果”的对象；await 会等待它完成。
  if (!wx.cloud) {
    throw new Error('当前微信版本不支持云开发')
  }

  const result = await wx.cloud.callFunction({
    name: options.name,
    data: options.data || {},
  })

  // 云函数返回值没有被微信类型完整描述，这里用类型断言告诉 TS 结果类型。
  return result.result as TResult
}
