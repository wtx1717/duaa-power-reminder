/// <reference path="./types/index.d.ts" />

interface IAppOption {
  globalData: {
    userInfo?: WechatMiniprogram.UserInfo,
    openid?: string,
    homePowerState?: {
      openidText: string,
      isAuthenticated: boolean,
      lightMeterId: string,
      acMeterId: string,
      lightPower: import('../miniprogram/types/domain').MeterPowerView,
      acPower: import('../miniprogram/types/domain').MeterPowerView,
    },
  }
  userInfoReadyCallback?: WechatMiniprogram.GetUserInfoSuccessCallback,
}
