# 数据库架构

本文档描述北航宿舍电量提醒小程序 MVP 阶段的云数据库集合设计。当前阶段以结构清晰和后续可扩展为主，不预设复杂查询算法。

## user_configs

用途：保存用户维度的电表绑定和提醒配置。每个微信用户通常只有一条配置。

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `_id` | string | 是 | 云数据库文档 ID |
| `openid` | string | 是 | 微信用户 openid |
| `lightMeterId` | string | 是 | 宿舍照明电表号 |
| `acMeterId` | string | 是 | 宿舍空调电表号 |
| `email` | string | 是 | 接收低电量邮件提醒的邮箱 |
| `thresholdKwh` | number | 是 | 后端固定低电量提醒阈值，当前为 20 kWh |
| `reminderEnabled` | boolean | 是 | 是否开启提醒 |
| `subscribeStatus` | string | 是 | 订阅消息授权状态：`unknown`、`accepted`、`rejected` |
| `createdAt` | Date | 是 | 创建时间 |
| `updatedAt` | Date | 是 | 更新时间 |

索引建议：

| 索引字段 | 类型 | 说明 |
| --- | --- | --- |
| `openid` | 唯一索引 | 快速读取和更新当前用户配置 |
| `lightMeterId` | 普通索引 | 根据照明电表反查受影响用户 |
| `acMeterId` | 普通索引 | 根据空调电表反查受影响用户 |

## meters

用途：按唯一电表号保存电表最新状态，避免多个用户绑定同一电表时重复查询。

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `_id` | string | 是 | 云数据库文档 ID |
| `meterId` | string | 是 | 唯一电表号 |
| `type` | string | 是 | 电表类型：`light` 或 `ac` |
| `lastRemainingKwh` | number | 否 | 最近一次查询到的剩余电量 |
| `lastQueriedAt` | Date | 否 | 最近查询时间 |
| `nextCheckAt` | Date | 否 | 下次应查询时间 |
| `failCount` | number | 是 | 连续查询失败次数 |
| `lastError` | string | 否 | 最近一次查询失败原因 |
| `createdAt` | Date | 是 | 创建时间 |
| `updatedAt` | Date | 是 | 更新时间 |

索引建议：

| 索引字段 | 类型 | 说明 |
| --- | --- | --- |
| `meterId` | 唯一索引 | 保证同一电表只保存一份状态 |
| `nextCheckAt` | 普通索引 | 定时任务查找需要查询的电表 |
| `type, nextCheckAt` | 复合索引 | 后续按电表类型分批调度时使用 |

## power_records

用途：保存每次电量查询结果，支持追踪历史、排查故障和后续优化调度策略。

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `_id` | string | 是 | 云数据库文档 ID |
| `meterId` | string | 是 | 电表号 |
| `remainingKwh` | number | 否 | 剩余电量，查询失败时可为空 |
| `cutoffTime` | string | 否 | 页面返回的截止或更新时间文本 |
| `address` | string | 否 | 页面返回的宿舍地址文本 |
| `ok` | boolean | 是 | 本次查询是否成功 |
| `error` | string | 否 | 失败原因 |
| `queriedAt` | Date | 是 | 查询时间 |
| `type` | string | 否 | 电表类型：`light` 或 `ac` |
| `source` | string | 否 | 查询来源：`queryPower` 或 `scheduledCheck` |

索引建议：

| 索引字段 | 类型 | 说明 |
| --- | --- | --- |
| `meterId, queriedAt` | 复合索引 | 查询某个电表的历史记录 |
| `queriedAt` | 普通索引 | 后续做数据清理或统计 |
| `ok, queriedAt` | 复合索引 | 统计失败率和排查异常 |

## notification_records

用途：保存低电量提醒发送记录，避免重复提醒并便于审计发送结果。

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `_id` | string | 是 | 云数据库文档 ID |
| `openid` | string | 是 | 接收提醒的用户 openid |
| `email` | string | 否 | 邮件提醒收件邮箱 |
| `meterId` | string | 是 | 触发提醒的电表号 |
| `type` | string | 否 | 本次提醒对应的电表类型：`light` 或 `ac` |
| `channel` | string | 否 | 提醒渠道，当前为 `email` |
| `remainingKwh` | number | 是 | 触发时剩余电量 |
| `thresholdKwh` | number | 是 | 本次通知使用的提醒阈值，当前为 20 kWh |
| `sentAt` | Date | 是 | 发送或尝试发送时间 |
| `status` | string | 是 | 状态：`pending`、`sent`、`failed`、`skipped` |
| `error` | string | 否 | 发送失败原因 |

当前提醒渠道为邮件。低电量邮件由 `scheduledCheck` 在后台定时查询后触发；`queryPower` 是手动查询入口，只返回查询结果并保留 `source: 'queryPower'` 的历史记录，不参与日耗估算、调度状态更新或低电量周期提醒判断。微信订阅消息接口暂时保留但不再实际发送。发送失败不会影响本次电量查询结果返回。

索引建议：

| 索引字段 | 类型 | 说明 |
| --- | --- | --- |
| `openid, sentAt` | 复合索引 | 查看某个用户的提醒历史 |
| `meterId, sentAt` | 复合索引 | 控制同一电表的提醒频率 |
| `status, sentAt` | 复合索引 | 排查失败提醒 |

## job_locks

用途：防止 `scheduledCheck` 并发执行导致重复查询和重复发送提醒。

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `_id` | string | 是 | 云数据库文档 ID |
| `name` | string | 是 | 锁名称，例如 `scheduledCheck` |
| `lockedUntil` | Date | 是 | 锁过期时间 |
| `owner` | string | 是 | 本次任务实例标识 |
| `updatedAt` | Date | 是 | 更新时间 |

索引建议：

| 索引字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | 唯一索引 | 同一种任务只能持有一把锁 |
| `lockedUntil` | 普通索引 | 清理过期锁或判断锁是否可抢占 |

## meter_check_jobs

用途：保存定时检查的随机错峰执行计划。`scheduledCheck` 每 30 分钟只负责规划任务，`scheduledCheckDispatch` 在工作时段每 5 分钟执行到点任务；`meters.nextCheckAt` 仍只在实际检查完成后更新。

字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `_id` | string | 是 | 云数据库文档 ID |
| `meterDocId` | string | 否 | 对应 `meters` 文档 ID |
| `meterId` | string | 是 | 电表号 |
| `type` | string | 是 | 电表类型：`light` 或 `ac` |
| `status` | string | 是 | 状态：`pending`、`running`、`done`、`failed`、`expired` |
| `runId` | string | 是 | 本轮规划实例标识 |
| `plannedAt` | Date | 是 | 随机分配后的实际执行时间 |
| `deadlineAt` | Date | 是 | 本轮执行截止时间，当前为规划触发后 30 分钟 |
| `attempts` | number | 否 | 抢占执行次数 |
| `error` | string | 否 | 失败或过期原因 |
| `createdAt` | Date | 是 | 任务创建时间 |
| `updatedAt` | Date | 是 | 更新时间 |
| `startedAt` | Date | 否 | 实际开始执行时间 |
| `finishedAt` | Date | 否 | 实际结束时间 |

索引建议：

| 索引字段 | 类型 | 说明 |
| --- | --- | --- |
| `status, plannedAt` | 复合索引 | 分发器读取到点待执行任务 |
| `meterId, status` | 复合索引 | 规划阶段跳过已有未完成任务 |
| `deadlineAt` | 普通索引 | 清理过期任务 |
