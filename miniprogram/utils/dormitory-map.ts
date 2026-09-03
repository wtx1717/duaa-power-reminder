import {
  DORMITORY_DATA,
  type DormitoryMeterTuple,
  type DormitoryRoomData,
} from '../data/dormitory-data'

export interface DormitoryMeter {
  meterId: string
  meterNo: string
  address: string
}

export interface DormitoryRoomMeters {
  light?: DormitoryMeter
  ac?: DormitoryMeter
}

export interface DormitoryLocation {
  campus: string
  building: string
  floor: string
  room: string
}

export interface DormitoryMatch extends DormitoryLocation {
  meters: DormitoryRoomMeters
}

function toMeter(tuple: DormitoryMeterTuple | undefined): DormitoryMeter | undefined {
  if (!tuple) {
    return undefined
  }

  return {
    meterId: tuple[0],
    meterNo: tuple[1],
    address: tuple[2],
  }
}

function sortValues(values: string[]): string[] {
  return values.sort((left, right) =>
    left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }),
  )
}

function getCampusData(campus: string) {
  return DORMITORY_DATA[campus]
}

function getBuildingData(campus: string, building: string) {
  const campusData = getCampusData(campus)
  return campusData ? campusData[building] : undefined
}

function getFloorData(campus: string, building: string, floor: string) {
  const buildingData = getBuildingData(campus, building)
  return buildingData ? buildingData[floor] : undefined
}

function getRoomData(
  campus: string,
  building: string,
  floor: string,
  room: string,
): DormitoryRoomData | undefined {
  const floorData = getFloorData(campus, building, floor)
  return floorData ? floorData[room] : undefined
}

export function getCampuses(): string[] {
  return sortValues(Object.keys(DORMITORY_DATA))
}

export function getBuildings(campus: string): string[] {
  return sortValues(Object.keys(getCampusData(campus) || {}))
}

export function getFloors(campus: string, building: string): string[] {
  return sortValues(Object.keys(getBuildingData(campus, building) || {}))
}

export function getRooms(campus: string, building: string, floor: string): string[] {
  return sortValues(Object.keys(getFloorData(campus, building, floor) || {}))
}

export function getRoomMeters(location: DormitoryLocation): DormitoryRoomMeters {
  const room = getRoomData(
    location.campus,
    location.building,
    location.floor,
    location.room,
  )

  return {
    light: toMeter(room ? room.light : undefined),
    ac: toMeter(room ? room.ac : undefined),
  }
}

function createMatch(
  campus: string,
  building: string,
  floor: string,
  room: string,
  meters: DormitoryRoomMeters,
): DormitoryMatch {
  return {
    campus,
    building,
    floor,
    room,
    meters,
  }
}

export function findDormitoryByMeterIds(
  lightMeterId: string,
  acMeterId: string,
): DormitoryMatch | undefined {
  const normalizedLightMeterId = lightMeterId.trim()
  const normalizedAcMeterId = acMeterId.trim()
  const hasLightMeterId = Boolean(normalizedLightMeterId)
  const hasAcMeterId = Boolean(normalizedAcMeterId)
  let lightMatch: DormitoryMatch | undefined
  let acMatch: DormitoryMatch | undefined

  for (const campus of getCampuses()) {
    for (const building of getBuildings(campus)) {
      for (const floor of getFloors(campus, building)) {
        for (const room of getRooms(campus, building, floor)) {
          const meters = getRoomMeters({ campus, building, floor, room })
          const hasLightMatch = Boolean(
            hasLightMeterId
            && meters.light
            && meters.light.meterId === normalizedLightMeterId,
          )
          const hasAcMatch = Boolean(
            hasAcMeterId
            && meters.ac
            && meters.ac.meterId === normalizedAcMeterId,
          )

          if (hasLightMatch && hasAcMatch) {
            return createMatch(campus, building, floor, room, meters)
          }

          if (hasLightMatch && !lightMatch) {
            lightMatch = createMatch(campus, building, floor, room, meters)
          }

          if (hasAcMatch && !acMatch) {
            acMatch = createMatch(campus, building, floor, room, meters)
          }
        }
      }
    }
  }

  if (hasLightMeterId && hasAcMeterId) {
    // 两张表都存在但没有命中同一房间时，不能猜测它们的对应关系。
    return undefined
  }

  return lightMatch || acMatch
}
