// 首页和设置页共用的状态构造工具。
// 微信页面通过 setData 更新 data；本文件返回“局部状态对象”，供页面一次性合并。
import type {
  LoginResult,
  MeterSnapshot,
  MeterPowerView,
  QueryPowerResult,
  UserPowerConfig,
} from '../types/domain'
import {
  findDormitoryByMeterIds,
  getBuildings,
  getCampuses,
  getFloors,
  getRoomMeters,
  getRooms,
  type DormitoryLocation,
  type DormitoryMatch,
} from './dormitory-map'

export type InputEvent = {
  // input 事件只保留页面实际需要的 value 字段。
  detail: {
    value: string
  }
}

export type PickerEvent = {
  // picker 的 value 可能是字符串或数字，调用方会显式转换成数组下标。
  detail: {
    value: string | number
  }
}

export interface HomePowerState {
  // 首页需要的最小状态；设置页保存成功后也会同步重置这部分状态。
  openidText: string
  isAuthenticated: boolean
  lightMeterId: string
  acMeterId: string
  lightPower: MeterPowerView
  acPower: MeterPowerView
}

export const CAMPUS_PLACEHOLDER = '请选择校区'
export const BUILDING_PLACEHOLDER = '请选择楼栋'
export const FLOOR_PLACEHOLDER = '请选择楼层'
export const ROOM_PLACEHOLDER = '请选择房间'

export function createMeterView(
  label: string,
  meterId = '',
  result?: QueryPowerResult,
  loading = false,
): MeterPowerView {
  // 把原始查询结果包装成 WXML 可以直接读取的显示对象。
  return {
    label,
    meterId,
    loading,
    displayText: result ? formatPowerResult(result) : undefined,
    result,
  }
}

export function formatPowerResult(result: QueryPowerResult): string {
  // 失败时优先显示后端错误；成功时把电量和可选的断电时间拼成一句话。
  if (!result.ok) {
    return result.error || '查询失败'
  }

  const remaining = result.remainingKwh === undefined
    ? '未知'
    : `${result.remainingKwh} kWh`
  const cutoff = result.cutoffTime ? `， ${result.cutoffTime}` : ''
  return `剩余 ${remaining}${cutoff}`
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function addPlaceholder(values: string[], placeholder: string): string[] {
  // picker 的第 0 项是提示文字，因此真实选项要整体向后移动一位。
  return [placeholder, ...values]
}

function createSnapshotResult(
  meterId: string,
  snapshot?: MeterSnapshot,
): QueryPowerResult | undefined {
  // 登录接口返回的是电表快照，不是新查询；这里把快照转换成首页可显示的结果。
  if (!snapshot || snapshot.lastRemainingKwh === undefined) {
    return undefined
  }

  return {
    meterId,
    remainingKwh: snapshot.lastRemainingKwh,
    ok: true,
    queriedAt: snapshot.lastQueriedAt || new Date().toISOString(),
  }
}

export function createHomePowerState(
  config?: Pick<UserPowerConfig, 'lightMeterId' | 'acMeterId'>,
  meters?: LoginResult['meters'],
  isAuthenticated = false,
): HomePowerState {
  // 页面首次打开、登录完成或保存配置后，都通过这里创建一致的首页状态。
  const lightMeterId = config ? config.lightMeterId : ''
  const acMeterId = config ? config.acMeterId : ''
  const lightResult = createSnapshotResult(lightMeterId, meters ? meters.light : undefined)
  const acResult = createSnapshotResult(acMeterId, meters ? meters.ac : undefined)

  return {
    openidText: isAuthenticated ? '已登录' : '体验模式',
    isAuthenticated,
    lightMeterId,
    acMeterId,
    lightPower: createMeterView('照明', lightMeterId, lightResult),
    acPower: createMeterView('空调', acMeterId, acResult),
  }
}

export function createUnselectedMeterPatch(message = '') {
  // 用户改变上级宿舍选择时，旧电表信息必须清空，避免显示与新房间不匹配的电表。
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

export function createEmptySelectorState() {
  // 初始化四级 picker：校区 -> 楼栋 -> 楼层 -> 房间。
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

export function createSelectionPatch(
  location: DormitoryLocation,
  preservedLightMeterId = '',
  preservedAcMeterId = '',
) {
  // 根据宿舍位置查找本地映射，并生成设置页四级 picker 和电表输入框所需的全部字段。
  const buildings = getBuildings(location.campus)
  const floors = getFloors(location.campus, location.building)
  const rooms = getRooms(location.campus, location.building, location.floor)
  const meters = getRoomMeters(location)
  // 自动匹配到的电表优先；没有匹配到时保留用户原来手动填写的编号。
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

export function createManualConfigPatch(lightMeterId: string, acMeterId: string) {
  // 如果本地宿舍映射找不到已保存的电表，就退回到手动输入模式。
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

export function createLoginSelectionPatch(
  lightMeterId: string,
  acMeterId: string,
): ReturnType<typeof createSelectionPatch> | ReturnType<typeof createManualConfigPatch> {
  // 登录后尝试用两块电表反向定位宿舍；定位失败时不能猜测宿舍，只保留手动配置。
  const match: DormitoryMatch | undefined = findDormitoryByMeterIds(lightMeterId, acMeterId)

  if (!match) {
    return createManualConfigPatch(lightMeterId, acMeterId)
  }

  return createSelectionPatch(match, lightMeterId, acMeterId)
}
