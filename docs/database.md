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
| `thresholdKwh` | number | 是 | 低电量提醒阈值，单位 kWh |
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
| `meterId` | string | 是 | 触发提醒的电表号 |
| `type` | string | 否 | 本次提醒对应的电表类型：`light` 或 `ac` |
| `remainingKwh` | number | 是 | 触发时剩余电量 |
| `thresholdKwh` | number | 是 | 用户配置的提醒阈值 |
| `sentAt` | Date | 是 | 发送或尝试发送时间 |
| `status` | string | 是 | 状态：`pending`、`sent`、`failed`、`skipped` |
| `error` | string | 否 | 发送失败原因 |

手动查询订阅消息 MVP 阶段，`queryPower` 只对照明电表查询结果发送订阅消息。照明电量查询成功且能解析到剩余电量后写入通知记录：用户接受订阅授权时尝试发送，结果记录为 `sent` 或 `failed`；用户拒绝授权或授权流程不可用时不发送，记录为 `skipped`。发送失败不会影响本次电量查询结果返回。

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
