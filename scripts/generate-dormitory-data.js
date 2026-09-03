const fs = require('fs')
const path = require('path')

const [, , lightAndShahePath, xueyuanRoadAcPath, outputPath] = process.argv

if (!lightAndShahePath || !xueyuanRoadAcPath || !outputPath) {
  console.error(
    'Usage: node scripts/generate-dormitory-data.js <light-and-shahe-json> <xueyuan-road-ac-json> <output-ts>',
  )
  process.exit(1)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'))
}

function getOrCreate(object, key, factory) {
  if (!object[key]) {
    object[key] = factory()
  }

  return object[key]
}

function setMeter(root, row, type) {
  const campus = getOrCreate(root, row.campus, () => ({}))
  const building = getOrCreate(campus, row.building, () => ({}))
  const floor = getOrCreate(building, String(row.floor), () => ({}))
  const room = getOrCreate(floor, String(row.room), () => ({}))

  if (room[type]) {
    throw new Error(
      `Duplicate ${type} record for ${row.campus}/${row.building}/${row.floor}/${row.room}`,
    )
  }

  room[type] = [
    String(row.identityNo),
    String(row.meterNo || ''),
    String(row.address || row.name || ''),
  ]
}

function getXueyuanRoadBuildingName(building) {
  const value = String(building).replace(/^学生公寓/, '').replace(/空调$/, '')
  const eastWestMatch = value.match(/^(\d+)号楼(东|西)$/)

  if (eastWestMatch) {
    return `本部南区${eastWestMatch[1]}${eastWestMatch[2]}`
  }

  const numberMatch = value.match(/^(\d+)号楼$/)

  if (!numberMatch) {
    throw new Error(`Unsupported Xueyuan Road air-conditioner building: ${building}`)
  }

  const number = numberMatch[1]

  if (number === '12') {
    return '本部北区12'
  }

  if (number === '16') {
    return '本部北区16号楼'
  }

  if (number === '20' || number === '21') {
    return `本部南区${number}`
  }

  return `本部南区${number}号楼`
}

function removeAirConditionerSuffix(room) {
  return String(room).replace(/空调$/, '')
}

function isNumericRoom(room) {
  return /^\d+$/.test(String(room))
}

function sortKeys(object) {
  return Object.keys(object).sort((left, right) =>
    left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }),
  )
}

function sortNestedObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return value
  }

  const sorted = {}

  for (const key of sortKeys(value)) {
    sorted[key] = sortNestedObject(value[key])
  }

  return sorted
}

function createDataModule(root) {
  const json = JSON.stringify(sortNestedObject(root))

  return `// Generated from the school's QueryIdData snapshots on 2026-09-03.
// Run scripts/generate-dormitory-data.js to refresh this file.
export type DormitoryMeterTuple = readonly [identityNo: string, meterNo: string, address: string]

export interface DormitoryRoomData {
  light?: DormitoryMeterTuple
  ac?: DormitoryMeterTuple
}

export type DormitoryData = Record<
  string,
  Record<string, Record<string, Record<string, DormitoryRoomData>>>
>

export const DORMITORY_DATA_VERSION = '2026-09-03'

export const DORMITORY_DATA: DormitoryData = ${json}
`
}

const lightAndShahe = readJson(lightAndShahePath)
const xueyuanRoadAc = readJson(xueyuanRoadAcPath)
const root = {}

for (const row of lightAndShahe) {
  if (row.campus === '学院路校区') {
    setMeter(root, row, 'light')
    continue
  }

  const type = String(row.address || '').includes('[空调]') ? 'ac' : 'light'
  setMeter(root, row, type)
}

let attachedAirConditioners = 0
let ignoredAirConditioners = 0

for (const row of xueyuanRoadAc) {
  const building = getXueyuanRoadBuildingName(row.building)
  const room = removeAirConditionerSuffix(row.room)

  if (!isNumericRoom(room)) {
    ignoredAirConditioners += 1
    continue
  }

  const campus = root['学院路校区']
  const targetRoom = campus
    && campus[building]
    && campus[building][String(row.floor)]
    && campus[building][String(row.floor)][room]

  if (!targetRoom) {
    ignoredAirConditioners += 1
    continue
  }

  if (targetRoom.ac) {
    throw new Error(
      `Duplicate normalized air-conditioner record for ${building}/${row.floor}/${room}`,
    )
  }

  targetRoom.ac = [
    String(row.identityNo),
    String(row.meterNo || ''),
    String(row.address || row.name || ''),
  ]
  attachedAirConditioners += 1
}

const output = createDataModule(root)
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
fs.writeFileSync(path.resolve(outputPath), output, 'utf8')

const roomCount = Object.values(root).reduce(
  (campusTotal, campus) => campusTotal + Object.values(campus).reduce(
    (buildingTotal, building) => buildingTotal + Object.values(building).reduce(
      (floorTotal, floor) => floorTotal + Object.keys(floor).length,
      0,
    ),
    0,
  ),
  0,
)

console.log(JSON.stringify({
  output: path.resolve(outputPath),
  roomCount,
  attachedAirConditioners,
  ignoredAirConditioners,
}, null, 2))
