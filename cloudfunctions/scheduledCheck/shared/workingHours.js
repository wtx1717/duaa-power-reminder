// 定时任务的北京时间窗口。
// 云函数运行环境可能使用 UTC，因此通过固定偏移计算北京时间的分钟数。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const PLAN_START_MINUTE = 8 * 60
const PLAN_END_MINUTE = 21 * 60
const DISPATCH_START_MINUTE = 8 * 60
const DISPATCH_END_MINUTE = 21 * 60 + 30

function getBeijingMinuteOfDay(value = new Date()) {
  // 先把时间加上 8 小时，再用 UTC getter 读取，避免依赖服务器本地时区。
  const date = value instanceof Date ? value : new Date(value)
  const beijingDate = new Date(date.getTime() + BEIJING_OFFSET_MS)

  return beijingDate.getUTCHours() * 60 + beijingDate.getUTCMinutes()
}

function canPlanScheduledCheck(value = new Date()) {
  // 计划生成窗口：北京时间 08:00 到 21:00。
  const minuteOfDay = getBeijingMinuteOfDay(value)
  return minuteOfDay >= PLAN_START_MINUTE && minuteOfDay <= PLAN_END_MINUTE
}

function canDispatchScheduledJob(value = new Date()) {
  // 任务分发窗口比计划窗口多延长 30 分钟，用于处理尾部任务。
  const minuteOfDay = getBeijingMinuteOfDay(value)
  return minuteOfDay >= DISPATCH_START_MINUTE && minuteOfDay <= DISPATCH_END_MINUTE
}

module.exports = {
  canDispatchScheduledJob,
  canPlanScheduledCheck,
  getBeijingMinuteOfDay,
}
