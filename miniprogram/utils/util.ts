// 通用的小程序工具函数。
// 当前只负责把 Date 格式化成页面日志使用的本地时间字符串。
export const formatTime = (date: Date) => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()

  return (
    [year, month, day].map(formatNumber).join('/') +
    ' ' +
    [hour, minute, second].map(formatNumber).join(':')
  )
}

const formatNumber = (n: number) => {
  // 不足两位的月份、日期、时分秒前面补 0，例如 8 变成 08。
  const s = n.toString()
  return s[1] ? s : '0' + s
}
