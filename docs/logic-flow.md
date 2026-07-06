# 程序逻辑链路图

当前版本以“用户保存配置 -> 后台定时查询 -> 按阈值判断 -> 邮件提醒”为主链路。手动查询只用于查看当前电量和保留查询历史，不参与调度估算或低电量周期提醒判断。微信订阅消息接口保留，但不再实际弹窗或发送。

```mermaid
flowchart TD
  A["用户打开小程序"] --> B["login 云函数获取 openid"]
  B --> C["读取 user_configs 和 meters"]
  C --> D["首页展示电表号、邮箱、阈值和最近状态"]

  D --> E["用户填写照明电表、空调电表、提醒邮箱、阈值"]
  E --> F["前端校验必填和邮箱格式"]
  F --> G["saveConfig 云函数"]
  G --> H["后端校验电表号、邮箱、阈值"]
  H --> I["写入 user_configs"]
  H --> J["upsert 两块电表到 meters"]

  D --> K["用户点击查询当前电量"]
  K --> L1["queryPower 查询照明电表"]
  K --> L2["queryPower 查询空调电表"]
  L1 --> M1["请求学校电量页面并解析剩余电量"]
  L2 --> M2["请求学校电量页面并解析剩余电量"]
  M1 --> N1["写入 source=queryPower 的 power_records"]
  M2 --> N2["写入 source=queryPower 的 power_records"]
  N1 --> P1["更新 meters 展示字段并返回查询结果"]
  N2 --> P2["更新 meters 展示字段并返回查询结果"]

  R["定时触发 scheduledCheck"] --> S["获取 job_locks 防并发锁"]
  S --> T["读取 nextCheckAt 到期的 meters"]
  T --> U["按电表去重查询学校电量页面"]
  U --> V["写入 power_records 并更新 meters"]
  V --> W["查找绑定该电表且 reminderEnabled=true 的用户"]
  W --> X{"逐个用户判断 remainingKwh <= thresholdKwh 且邮箱有效?"}
  X -- "否" --> Y["不发送提醒"]
  X -- "是" --> Q

  Q --> Z["sendEmailNotification 校验输入"]
  Z --> AA["反查 user_configs 确认邮箱和电表属于该用户"]
  AA --> AB["读取 SMTP 环境变量"]
  AB --> AC["通过 163 SMTP 发送邮件"]
  AC --> AD["调用方写入 notification_records"]
```

## 关键规则

- 保存配置时邮箱必填，旧用户需要重新保存一次配置补齐 `email`。
- 照明和空调电表都会参与后台提醒判断。
- 邮件提醒只由 `scheduledCheck` 触发，触发条件是后台查询结果 `remainingKwh <= thresholdKwh`。
- `queryPower` 写入 `source=queryPower` 的历史记录，但不更新 `nextCheckAt`、`scheduleMode` 或 `estimatedDailyUsageKwh`。
- 邮件中的查询时间按 `MAIL_TIME_ZONE` 环境变量格式化，未配置时默认使用 `Asia/Shanghai`。
- `notification_records.channel` 当前写入 `email`。

## 需要重新上传的云函数

- `sendEmailNotification`：修复邮件查询时间展示。
- 其他云函数本次未改动时不必重新上传。
