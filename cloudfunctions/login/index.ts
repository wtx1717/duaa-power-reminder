export interface LoginResult {
  openid: string
}

export async function main(): Promise<LoginResult> {
  // TODO: Use wx-server-sdk cloud.getWXContext() to return current user's openid.
  return {
    openid: '',
  }
}
