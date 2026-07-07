const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const PLAN_START_MINUTE = 8 * 60
const PLAN_END_MINUTE = 21 * 60
const DISPATCH_START_MINUTE = 8 * 60
const DISPATCH_END_MINUTE = 21 * 60 + 30

function getBeijingMinuteOfDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const beijingDate = new Date(date.getTime() + BEIJING_OFFSET_MS)

  return beijingDate.getUTCHours() * 60 + beijingDate.getUTCMinutes()
}

function canPlanScheduledCheck(value = new Date()) {
  const minuteOfDay = getBeijingMinuteOfDay(value)
  return minuteOfDay >= PLAN_START_MINUTE && minuteOfDay <= PLAN_END_MINUTE
}

function canDispatchScheduledJob(value = new Date()) {
  const minuteOfDay = getBeijingMinuteOfDay(value)
  return minuteOfDay >= DISPATCH_START_MINUTE && minuteOfDay <= DISPATCH_END_MINUTE
}

module.exports = {
  canDispatchScheduledJob,
  canPlanScheduledCheck,
  getBeijingMinuteOfDay,
}
