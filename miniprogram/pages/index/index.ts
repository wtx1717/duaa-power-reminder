import { clearAuthenticated, hasAuthenticated, loginWithWechat } from '../../services/auth'
import { queryPower, savePowerConfig, unbindPowerConfig } from '../../services/meter'
import {
  findDormitoryByMeterIds,
  getBuildings,
  getCampuses,
  getFloors,
  getRoomMeters,
  getRooms,
  type DormitoryLocation,
  type DormitoryMatch,
} from '../../utils/dormitory-map'
import type {
  MeterPowerView,
  QueryPowerResult,
  SaveConfigPayload,
  UnbindConfigResult,
} from '../../types/domain'

type InputEvent = {
  detail: {
    value: string
  }
}

type PickerEvent = {
  detail: {
    value: string | number
  }
}

const QUERY_BUTTON_COOLDOWN_MS = 3000
const QUERY_TOO_FREQUENT_MESSAGE = '操作过于频繁，请稍后再试'
const CAMPUS_PLACEHOLDER = '请选择校区'
const BUILDING_PLACEHOLDER = '请选择楼栋'
const FLOOR_PLACEHOLDER = '请选择楼层'
const ROOM_PLACEHOLDER = '请选择房间'

// function maskOpenid(openid: string): string {
//   if (openid.length <= 8) {
//     return openid
//   }

//   return `${openid.slice(0, 4)}****${openid.slice(-4)}`
// }

function createMeterView(
  label: string,
  meterId = '',
  result?: QueryPowerResult,
  loading = false,
): MeterPowerView {
  return {
    label,
    meterId,
    loading,
    displayText: result ? formatPowerResult(result) : undefined,
    result,
  }
}

function formatPowerResult(result: QueryPowerResult): string {
  if (!result.ok) {
    return result.error || '查询失败'
  }

  const remaining = result.remainingKwh === undefined
    ? '未知'
    : `${result.remainingKwh} kWh`
  const cutoff = result.cutoffTime ? `， ${result.cutoffTime}` : ''
  return `剩余 ${remaining}${cutoff}`
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function addPlaceholder(values: string[], placeholder: string): string[] {
  return [placeholder, ...values]
}

function createUnselectedMeterPatch(message = '') {
  return {
    lightMeterId: '',
    acMeterId: '',
    lightMeterNo: '',
    acMeterNo: '',
    lightMeterAddress: '',
    acMeterAddress: '',
    lightMeterEditable: true,
    acMeterEditable: true,
    mappingMessage: message,
    lightPower: createMeterView('照明'),
    acPower: createMeterView('空调'),
  }
}

function createEmptySelectorState() {
  return {
    campusOptions: addPlaceholder(getCampuses(), CAMPUS_PLACEHOLDER),
    campusIndex: 0,
    buildingOptions: [BUILDING_PLACEHOLDER],
    buildingIndex: 0,
    floorOptions: [FLOOR_PLACEHOLDER],
    floorIndex: 0,
    roomOptions: [ROOM_PLACEHOLDER],
    roomIndex: 0,
    ...createUnselectedMeterPatch(),
  }
}

function getPickerIndex(options: string[], value: string): number {
  const index = options.indexOf(value)
  return index >= 0 ? index : 0
}

function createSelectionPatch(
  location: DormitoryLocation,
  preservedLightMeterId = '',
  preservedAcMeterId = '',
) {
  const buildings = getBuildings(location.campus)
  const floors = getFloors(location.campus, location.building)
  const rooms = getRooms(location.campus, location.building, location.floor)
  const meters = getRoomMeters(location)
  const lightMeterId = (meters.light ? meters.light.meterId : '') || preservedLightMeterId
  const acMeterId = (meters.ac ? meters.ac.meterId : '') || preservedAcMeterId
  const mappingMessage = meters.light && meters.ac
    ? '已自动匹配照明和空调电表'
    : meters.light
      ? '已匹配照明电表，空调电表需要手动填写'
      : meters.ac
        ? '已匹配空调电表，照明电表需要手动填写'
        : '该房间没有自动匹配的电表，请手动填写'

  return {
    campusIndex: getPickerIndex(
      addPlaceholder(getCampuses(), CAMPUS_PLACEHOLDER),
      location.campus,
    ),
    buildingOptions: addPlaceholder(buildings, BUILDING_PLACEHOLDER),
    buildingIndex: getPickerIndex(
      addPlaceholder(buildings, BUILDING_PLACEHOLDER),
      location.building,
    ),
    floorOptions: addPlaceholder(floors, FLOOR_PLACEHOLDER),
    floorIndex: getPickerIndex(
      addPlaceholder(floors, FLOOR_PLACEHOLDER),
      location.floor,
    ),
    roomOptions: addPlaceholder(rooms, ROOM_PLACEHOLDER),
    roomIndex: getPickerIndex(
      addPlaceholder(rooms, ROOM_PLACEHOLDER),
      location.room,
    ),
    lightMeterId,
    acMeterId,
    lightMeterNo: meters.light ? meters.light.meterNo : '',
    acMeterNo: meters.ac ? meters.ac.meterNo : '',
    lightMeterAddress: meters.light ? meters.light.address : '',
    acMeterAddress: meters.ac ? meters.ac.address : '',
    lightMeterEditable: !meters.light,
    acMeterEditable: !meters.ac,
    mappingMessage,
    lightPower: createMeterView('照明', lightMeterId),
    acPower: createMeterView('空调', acMeterId),
  }
}

function createManualConfigPatch(lightMeterId: string, acMeterId: string) {
  return {
    ...createEmptySelectorState(),
    lightMeterId,
    acMeterId,
    mappingMessage: lightMeterId || acMeterId
      ? '未能从本地宿舍映射恢复，请核对电表号'
      : '',
    lightPower: createMeterView('照明', lightMeterId),
    acPower: createMeterView('空调', acMeterId),
  }
}

function createLoginSelectionPatch(
  lightMeterId: string,
  acMeterId: string,
): ReturnType<typeof createSelectionPatch> | ReturnType<typeof createManualConfigPatch> {
  const match: DormitoryMatch | undefined = findDormitoryByMeterIds(lightMeterId, acMeterId)

  if (!match) {
    return createManualConfigPatch(lightMeterId, acMeterId)
  }

  return createSelectionPatch(match, lightMeterId, acMeterId)
}

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

function resetUnboundState() {
  return {
    openid: '',
    openidText: '体验模式',
    email: '',
    message: '',
    isAuthenticated: false,
    queryCooldownUntil: 0,
    ...createEmptySelectorState(),
  }
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

  if (/查询用户配置失败/.test(message)) {
    return message
  }

  if (/删除用户配置失败/.test(message)) {
    return message
  }

  if (/调度任务处理失败/.test(message)) {
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

Page({
  data: {
    openid: '',
    openidText: '体验模式',
    email: '',
    loading: true,
    saving: false,
    queryingAll: false,
    message: '',
    isAuthenticated: false,
    queryCooldownUntil: 0,
    ...createEmptySelectorState(),
  },

  async onLoad() {
    if (!hasAuthenticated()) {
      this.setData({
        loading: false,
        isAuthenticated: false,
      })
      return
    }

    await this.login()
  },

  onShow() {
    if (!hasAuthenticated() || this.data.isAuthenticated || this.data.loading) {
      return
    }

    this.login()
  },

  async login() {
    this.setData({
      loading: true,
      message: '',
    })

    try {
      const result = await loginWithWechat()
      const app = getApp<IAppOption>()
      app.globalData.openid = result.openid
      const config = result.config
      const lightMeterId = config ? config.lightMeterId : ''
      const acMeterId = config ? config.acMeterId : ''
      const email = config && config.email ? config.email : ''
      const selectionPatch = createLoginSelectionPatch(lightMeterId, acMeterId)

      this.setData({
        openid: result.openid,
        openidText: '已登录',
        email,
        isAuthenticated: true,
        ...selectionPatch,
      })
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '登录失败，请稍后重试',
      })
    } finally {
      this.setData({
        loading: false,
      })
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
      content: '保存配置和查询电量需要登录，请先授权登录。',
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
      buildingOptions: addPlaceholder(getBuildings(campus), BUILDING_PLACEHOLDER),
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
      floorOptions: addPlaceholder(getFloors(campus, building), FLOOR_PLACEHOLDER),
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
        roomOptions: [ROOM_PLACEHOLDER],
        roomIndex: 0,
        ...createUnselectedMeterPatch(),
      })
      return
    }

    this.setData({
      floorIndex,
      roomOptions: addPlaceholder(getRooms(campus, building, floor), ROOM_PLACEHOLDER),
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
    })
  },

  onLightMeterInput(event: InputEvent) {
    const lightMeterId = event.detail.value.trim()
    this.setData({
      lightMeterId,
      lightMeterNo: '',
      lightMeterAddress: '',
      lightPower: createMeterView('照明', lightMeterId),
    })
  },

  onAcMeterInput(event: InputEvent) {
    const acMeterId = event.detail.value.trim()
    this.setData({
      acMeterId,
      acMeterNo: '',
      acMeterAddress: '',
      acPower: createMeterView('空调', acMeterId),
    })
  },

  onEmailInput(event: InputEvent) {
    this.setData({
      email: event.detail.value.trim(),
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

      this.setData({
        message: '配置已保存，低电量提醒将发送到邮箱',
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
      this.setData({
        saving: false,
      })
    }
  },

  async onQueryPower() {
    if (!this.requireLogin()) {
      return
    }

    const now = Date.now()

    if (this.data.queryingAll || this.data.queryCooldownUntil > now) {
      return
    }

    const payload = this.buildSavePayload()

    if (!payload) {
      return
    }

    this.setData({
      queryingAll: true,
      queryCooldownUntil: now + QUERY_BUTTON_COOLDOWN_MS,
      message: '',
      'lightPower.loading': true,
      'acPower.loading': true,
    })

    try {
      const [lightResult, acResult] = await Promise.all([
        queryPower({
          meterId: payload.lightMeterId,
          type: 'light',
        }),
        queryPower({
          meterId: payload.acMeterId,
          type: 'ac',
        }),
      ])

      const rateLimitedResult = [lightResult, acResult].find(
        (result) => result.error === QUERY_TOO_FREQUENT_MESSAGE,
      )

      this.setData({
        lightPower: createMeterView('照明', payload.lightMeterId, lightResult),
        acPower: createMeterView('空调', payload.acMeterId, acResult),
        message: lightResult.ok || acResult.ok
          ? '查询完成'
          : rateLimitedResult
            ? QUERY_TOO_FREQUENT_MESSAGE
            : '两个电表都查询失败',
      })
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : '查询失败，请稍后重试',
        'lightPower.loading': false,
        'acPower.loading': false,
      })
    } finally {
      this.setData({
        queryingAll: false,
      })
    }
  },

  async onUnbindAndLogout() {
    if (!this.requireLogin()) {
      return
    }

    if (this.data.loading || this.data.saving || this.data.queryingAll) {
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
      clearAuthenticated()
      this.setData(resetUnboundState())

      wx.showToast({
        title: '解绑成功',
        icon: 'success',
      })

      wx.reLaunch({
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
