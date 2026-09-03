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
  detail: {
    value: string
  }
}

export type PickerEvent = {
  detail: {
    value: string | number
  }
}

export interface HomePowerState {
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
  return {
    label,
    meterId,
    loading,
    displayText: result ? formatPowerResult(result) : undefined,
    result,
  }
}

export function formatPowerResult(result: QueryPowerResult): string {
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
  return [placeholder, ...values]
}

function createSnapshotResult(
  meterId: string,
  snapshot?: MeterSnapshot,
): QueryPowerResult | undefined {
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
  const lightMeterId = config ? config.lightMeterId : ''
  const acMeterId = config ? config.acMeterId : ''
  const lightResult = createSnapshotResult(lightMeterId, meters?.light)
  const acResult = createSnapshotResult(acMeterId, meters?.ac)

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

export function createManualConfigPatch(lightMeterId: string, acMeterId: string) {
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
  const match: DormitoryMatch | undefined = findDormitoryByMeterIds(lightMeterId, acMeterId)

  if (!match) {
    return createManualConfigPatch(lightMeterId, acMeterId)
  }

  return createSelectionPatch(match, lightMeterId, acMeterId)
}
