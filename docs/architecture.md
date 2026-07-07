# 项目架构

北航宿舍电量提醒小程序采用微信原生小程序前端、云函数后端和云数据库的结构。当前阶段已经接入电量查询、邮件提醒和基于后台采样的单电表动态调度。

## 目录分层

```text
miniprogram/          小程序前端
cloudfunctions/       云函数后端
cloudfunctions/shared 后端共享类型和基础模块
docs/                 架构和数据库文档
```

## 小程序前端职责

前端负责微信登录入口、用户电表配置填写、提醒邮箱和结果展示。前端只调用云函数，不保存任何敏感凭据，也不直接访问电量查询页面。

当前新增的 `miniprogram/services/` 只提供云函数调用封装和业务 API 占位，`miniprogram/types/` 保存前端领域类型。后续页面开发时应优先复用这些 service，避免页面直接散落 `wx.cloud.callFunction`。

## 云函数职责

云函数负责所有可信后端逻辑：

| 云函数 | 职责 |
| --- | --- |
| `login` | 获取当前微信用户 openid |
| `saveConfig` | 校验并保存用户电表绑定、提醒邮箱和提醒开关，后端固定提醒阈值为 20 kWh |
| `queryPower` | 手动查询单个电表电量并保存 `source=queryPower` 的查询记录 |
| `scheduledCheck` | 定时扫描到期电表，触发后台查询、动态调度和低电量提醒 |
| `sendEmailNotification` | 使用 SMTP 发送低电量邮件提醒 |

`cloudfunctions/shared/` 保存可复用模块：数据库集合名、领域类型、电量页面请求、HTML 解析、调度策略和订阅消息发送。当前这些模块只保留函数签名和 TODO，真实实现应在后续功能阶段补充。

## 数据库职责

数据库分为用户配置、电表状态、查询历史、提醒历史和任务锁五类集合：

| 集合 | 职责 |
| --- | --- |
| `user_configs` | 保存用户绑定和提醒配置 |
| `meters` | 按唯一电表号保存最新状态和下次查询时间 |
| `power_records` | 保存每次电量查询结果 |
| `notification_records` | 保存提醒发送记录 |
| `job_locks` | 防止定时任务并发重复执行 |

详细字段和索引见 `docs/database.md`。

## scheduledCheck 执行流程

1. 获取 `job_locks` 中的 `scheduledCheck` 锁，避免多个任务实例同时运行。
2. 从 `meters` 查询 `nextCheckAt <= now` 的电表。
3. 对每个到期电表调用电量查询模块，解析并写入 `source=scheduledCheck` 的 `power_records`。
4. 更新 `meters.lastRemainingKwh`、`lastQueriedAt`、`nextCheckAt`、`estimatedDailyUsageKwh`、`scheduleMode`、`failCount` 和 `lastError`。
5. 找到绑定该电表且开启提醒的 `user_configs`。
6. 当剩余电量小于等于后端固定阈值 20 kWh 时，调用邮件提醒云函数并写入 `notification_records`。
7. 释放或更新任务锁。

## 按唯一电表号去重的原因

同一宿舍的成员可能绑定同一照明电表和空调电表。如果按用户配置逐条查询，会对同一个电表重复请求，增加云函数耗时、外部页面压力和失败概率。

使用 `meters.meterId` 作为唯一状态源后，定时任务只需要查询每个电表一次，再把结果分发给绑定该电表的用户。这样也更容易积累电表级历史数据，后续可基于真实用电速度优化调度。

## 当前阶段的 nextCheckAt 策略

调度只使用后台 `scheduledCheck` 采样记录，不使用用户手动查询记录。新电表保存后会设置 `nextCheckAt = now`，由定时任务完成首次后台采样。

首次后台采样只作为基线。后续只有当两次后台成功采样间隔至少 24 小时，且未检测到充值时，才用实际用电量平滑更新 `estimatedDailyUsageKwh`。剩余电量充足时按线性预测降低查询频率，接近阈值或已提醒时改为每天查询。

## 后续替换 planner.ts 的方向

后续可以只替换 `cloudfunctions/shared/planner.ts`，保持 `scheduledCheck` 主流程不变。可选策略包括：

| 策略 | 说明 |
| --- | --- |
| 低电量更频繁 | 剩余电量接近阈值时缩短检查间隔 |
| 消耗速度估计 | 使用 `power_records` 计算最近几次 kWh/day |
| 失败退避 | 页面异常或网络失败时使用短间隔重试，连续失败后延长间隔 |
| 电表类型区分 | 空调电表在高用电季更频繁，照明电表保持较低频率 |
| 固定阈值感知 | 按后端固定 20 kWh 阈值决定最晚检查时间 |

这个设计让调度优化集中在 planner 模块内完成，避免影响前端、数据库集合和通知发送模块。
