import { clearAuthenticated, hasAuthenticated, loginWithWechat } from '../../services/auth'
import {
  getCachedLoginResult,
  isCachedLoginResultFresh,
  setCachedPowerConfig,
} from '../../services/config-cache'
import { savePowerConfig, unbindPowerConfig } from '../../services/meter'
import type { LoginResult, SaveConfigPayload, UnbindConfigResult } from '../../types/domain'
import {
  BUILDING_PLACEHOLDER,
  FLOOR_PLACEHOLDER,
  ROOM_PLACEHOLDER,
  createEmptySelectorState,
  createHomePowerState,
  createLoginSelectionPatch,
  createMeterView,
  createSelectionPatch,
  createUnselectedMeterPatch,
  isValidEmail,
  type PickerEvent,
  type InputEvent,
} from '../../utils/power-state'
import {
  getBuildings,
  getFloors,
  getRooms,
  type DormitoryLocation,
} from '../../utils/dormitory-map'

const LOGIN_CACHE_MAX_AGE_MS = 5 * 60 * 1000

function showConfirmModal(content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '确认解绑',
      content,
      confirmText: '继续解绑',
      confirmColor: '#b5452f',
      success(result) {
        resolve(result.confirm)
      },
      fail() {
        resolve(false)
      },
    })
  })
}

function formatUnbindError(error: unknown): string {
  let message = ''

  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === 'string') {
    message = error
  } else if (error && typeof error === 'object') {
    const value = error as {
      errMsg?: unknown
      message?: unknown
      error?: unknown
    }
    const details = [value.errMsg, value.message, value.error]
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
    message = details[0] || ''
  }

  if (!message) {
    return '云函数返回未知错误'
  }

  if (/无法获取当前用户身份/.test(message)) {
    return '无法获取当前用户身份'
  }

  if (/查询用户配置失败|删除用户配置失败|调度任务处理失败/.test(message)) {
    return message
  }

  if (/电表清理失败|查询电表失败|查询其他用户绑定失败/.test(message)) {
    return message
  }

  if (/request|timeout|network|fail|interrupted|ERR_/i.test(message)) {
    return '网络异常，请稍后重试'
  }

  return `云函数返回未知错误：${message}`
}

function resetUnboundState() {
  return {
    openid: '',
    openidText: '体验模式',
    email: '',
    loading: false,
    saving: false,
    message: '',
    isAuthenticated: false,
    formDirty: false,
    refreshingLogin: false,
    ...createEmptySelectorState(),
  }
}

Page({
  data: {
    openid: '',
    openidText: '体验模式',
    email: '',
    loading: false,
    saving: false,
    message: '',
    isAuthenticated: false,
    formDirty: false,
    refreshingLogin: false,
    ...createEmptySelectorState(),
  },

  onLoad() {
    if (!hasAuthenticated()) {
      this.setData({ loading: false })
    }
  },

  onShow() {
    if (!hasAuthenticated()) {
      this.setData(resetUnboundState())
      return
    }

    const cached = getCachedLoginResult()
    if (cached) {
      this.applyLoginResult(cached)

      if (
        isCachedLoginResultFresh(LOGIN_CACHE_MAX_AGE_MS)
        || this.data.loading
        || this.data.refreshingLogin
      ) {
        return
      }

      this.login({ silent: true })
      return
    }

    if (this.data.loading) {
      return
    }

    this.login()
  },

  applyLoginResult(result: LoginResult) {
    const config = result.config
    const lightMeterId = config ? config.lightMeterId : ''
    const acMeterId = config ? config.acMeterId : ''
    const email = config && config.email ? config.email : ''
    const selectionPatch = createLoginSelectionPatch(lightMeterId, acMeterId)
    const app = getApp<IAppOption>()

    app.globalData.openid = result.openid
    app.globalData.homePowerState = createHomePowerState(
      config
        ? { lightMeterId: config.lightMeterId, acMeterId: config.acMeterId }
        : undefined,
      result.meters,
      true,
    )

    this.setData({
      openid: result.openid,
      openidText: '已登录',
      email,
      isAuthenticated: true,
      formDirty: false,
      ...selectionPatch,
    })
  },

  async login(options: { silent?: boolean } = {}) {
    if (options.silent && (this.data.loading || this.data.refreshingLogin)) {
      return
    }

    if (!options.silent) {
      this.setData({
        loading: true,
        message: '',
      })
    } else {
      this.setData({
        message: '',
        refreshingLogin: true,
      })
    }

    try {
      const result = await loginWithWechat()
      if (options.silent && this.data.formDirty) {
        return
      }

      this.applyLoginResult(result)
    } catch (error) {
      if (!options.silent) {
        this.setData({
          message: error instanceof Error ? error.message : '登录失败，请稍后重试',
        })
      }
    } finally {
      if (!options.silent) {
        this.setData({ loading: false })
      } else {
        this.setData({ refreshingLogin: false })
      }
    }
  },

  onAuthorizeLogin() {
    if (this.data.loading || this.data.isAuthenticated) {
      return
    }

    wx.navigateTo({
      url: '/pages/login/login',
    })
  },

  requireLogin(): boolean {
    if (hasAuthenticated()) {
      return true
    }

    wx.showModal({
      title: '需要登录',
      content: '保存配置需要登录，请先授权登录。',
      confirmText: '去登录',
      success: (result) => {
        if (result.confirm) {
          this.onAuthorizeLogin()
        }
      },
    })

    return false
  },

  onCampusChange(event: PickerEvent) {
    const campusIndex = Number(event.detail.value)
    const campus = this.data.campusOptions[campusIndex]

    if (!campus || campusIndex === 0) {
      this.setData({
        campusIndex: 0,
        formDirty: true,
        buildingOptions: [BUILDING_PLACEHOLDER],
        buildingIndex: 0,
        floorOptions: [FLOOR_PLACEHOLDER],
        floorIndex: 0,
        roomOptions: [ROOM_PLACEHOLDER],
        roomIndex: 0,
        ...createUnselectedMeterPatch(),
      })
      return
    }

    this.setData({
      campusIndex,
      formDirty: true,
      buildingOptions: [BUILDING_PLACEHOLDER, ...getBuildings(campus)],
      buildingIndex: 0,
      floorOptions: [FLOOR_PLACEHOLDER],
      floorIndex: 0,
      roomOptions: [ROOM_PLACEHOLDER],
      roomIndex: 0,
      ...createUnselectedMeterPatch(),
    })
  },

  onBuildingChange(event: PickerEvent) {
    const campus = this.data.campusOptions[this.data.campusIndex]
    const buildingIndex = Number(event.detail.value)
    const building = this.data.buildingOptions[buildingIndex]

    if (!campus || this.data.campusIndex === 0 || !building || buildingIndex === 0) {
      this.setData({
        buildingIndex: 0,
        formDirty: true,
        floorOptions: [FLOOR_PLACEHOLDER],
        floorIndex: 0,
        roomOptions: [ROOM_PLACEHOLDER],
        roomIndex: 0,
        ...createUnselectedMeterPatch(),
      })
      return
    }

    this.setData({
      buildingIndex,
      formDirty: true,
      floorOptions: [FLOOR_PLACEHOLDER, ...getFloors(campus, building)],
      floorIndex: 0,
      roomOptions: [ROOM_PLACEHOLDER],
      roomIndex: 0,
      ...createUnselectedMeterPatch(),
    })
  },

  onFloorChange(event: PickerEvent) {
    const campus = this.data.campusOptions[this.data.campusIndex]
    const building = this.data.buildingOptions[this.data.buildingIndex]
    const floorIndex = Number(event.detail.value)
    const floor = this.data.floorOptions[floorIndex]

    if (
      !campus
      || this.data.campusIndex === 0
      || !building
      || this.data.buildingIndex === 0
      || !floor
      || floorIndex === 0
    ) {
      this.setData({
        floorIndex: 0,
        formDirty: true,
        roomOptions: [ROOM_PLACEHOLDER],
        roomIndex: 0,
        ...createUnselectedMeterPatch(),
      })
      return
    }

    this.setData({
      floorIndex,
      formDirty: true,
      roomOptions: [ROOM_PLACEHOLDER, ...getRooms(campus, building, floor)],
      roomIndex: 0,
      ...createUnselectedMeterPatch(),
    })
  },

  onRoomChange(event: PickerEvent) {
    const campus = this.data.campusOptions[this.data.campusIndex]
    const building = this.data.buildingOptions[this.data.buildingIndex]
    const floor = this.data.floorOptions[this.data.floorIndex]
    const roomIndex = Number(event.detail.value)
    const room = this.data.roomOptions[roomIndex]

    if (
      !campus
      || this.data.campusIndex === 0
      || !building
      || this.data.buildingIndex === 0
      || !floor
      || this.data.floorIndex === 0
      || !room
      || roomIndex === 0
    ) {
      this.setData({
        roomIndex: 0,
        formDirty: true,
        ...createUnselectedMeterPatch(),
      })
      return
    }

    const location: DormitoryLocation = {
      campus,
      building,
      floor,
      room,
    }

    this.setData({
      ...createSelectionPatch(location),
      roomIndex,
      formDirty: true,
    })
  },

  onLightMeterInput(event: InputEvent) {
    const lightMeterId = event.detail.value.trim()
    this.setData({
      lightMeterId,
      formDirty: true,
      lightMeterNo: '',
      lightMeterAddress: '',
      lightPower: createMeterView('照明', lightMeterId),
    })
  },

  onAcMeterInput(event: InputEvent) {
    const acMeterId = event.detail.value.trim()
    this.setData({
      acMeterId,
      formDirty: true,
      acMeterNo: '',
      acMeterAddress: '',
      acPower: createMeterView('空调', acMeterId),
    })
  },

  onEmailInput(event: InputEvent) {
    this.setData({
      email: event.detail.value.trim(),
      formDirty: true,
    })
  },

  buildSavePayload(silent = false): SaveConfigPayload | undefined {
    const payload: SaveConfigPayload = {
      lightMeterId: this.data.lightMeterId.trim(),
      acMeterId: this.data.acMeterId.trim(),
      email: this.data.email.trim(),
      reminderEnabled: true,
    }

    if (!payload.lightMeterId) {
      if (!silent) {
        this.setData({ message: '请选择宿舍，或填写宿舍照明电表号' })
      }
      return undefined
    }

    if (!payload.acMeterId) {
      if (!silent) {
        this.setData({ message: '请选择宿舍，或填写宿舍空调电表号' })
      }
      return undefined
    }

    if (payload.lightMeterId === payload.acMeterId) {
      if (!silent) {
        this.setData({ message: '照明电表号和空调电表号不能相同' })
      }
      return undefined
    }

    if (!payload.email) {
      if (!silent) {
        this.setData({ message: '请填写提醒邮箱' })
      }
      return undefined
    }

    if (!isValidEmail(payload.email)) {
      if (!silent) {
        this.setData({ message: '提醒邮箱格式不正确' })
      }
      return undefined
    }

    return payload
  },

  async onSaveConfig() {
    if (!this.requireLogin()) {
      return
    }

    const initialPayload = this.buildSavePayload()
    if (!initialPayload) {
      return
    }

    this.setData({
      saving: true,
      message: '',
    })

    try {
      const payload = this.buildSavePayload(false)
      if (!payload) {
        return
      }

      const result = await savePowerConfig(payload)
      if (!result.ok) {
        throw new Error(result.error || '保存失败，请稍后重试')
      }

      const app = getApp<IAppOption>()
      const savedConfig = result.config || (app.globalData.openid
        ? {
            openid: app.globalData.openid,
            ...payload,
          }
        : undefined)

      if (savedConfig) {
        setCachedPowerConfig(savedConfig)
      }

      app.globalData.homePowerState = createHomePowerState(
        {
          lightMeterId: payload.lightMeterId,
          acMeterId: payload.acMeterId,
        },
        undefined,
        true,
      )

      this.setData({
        message: '配置已保存，低电量提醒将发送到邮箱',
        formDirty: false,
        lightPower: createMeterView('照明', payload.lightMeterId),
        acPower: createMeterView('空调', payload.acMeterId),
      })

      wx.showToast({
        title: '已保存',
        icon: 'success',
      })
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '保存失败，请稍后重试',
      })
    } finally {
      this.setData({ saving: false })
    }
  },

  async onUnbindAndLogout() {
    if (!this.requireLogin()) {
      return
    }

    if (this.data.loading || this.data.saving) {
      return
    }

    const confirmed = await showConfirmModal(
      '解绑后将删除当前电表和邮箱配置，关闭低电量提醒，并退出当前账号。历史查询记录和提醒记录会保留。确定继续吗？',
    )

    if (!confirmed) {
      return
    }

    this.setData({
      loading: true,
      message: '',
    })

    try {
      const result: UnbindConfigResult = await unbindPowerConfig()

      if (!result || !result.ok) {
        throw new Error(result && result.error ? result.error : '云函数返回未知错误')
      }

      const app = getApp<IAppOption>()
      app.globalData.openid = undefined
      app.globalData.homePowerState = undefined
      clearAuthenticated()
      this.setData(resetUnboundState())

      wx.showToast({
        title: '解绑成功',
        icon: 'success',
      })

      wx.switchTab({
        url: '/pages/index/index',
      })
    } catch (error) {
      this.setData({
        loading: false,
        message: formatUnbindError(error),
      })
    }
  },
})
