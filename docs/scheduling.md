# 单电表动态调度

当前调度以 `meters` 集合中的单个电表为单位执行。照明表和空调表互不影响，各自维护估算日耗、下次查询时间、低电量状态和充值检测状态。

## 手动查询和后台查询

- `queryPower` 是手动查询入口，只用于展示当前结果和保留历史记录。
- 手动查询写入 `power_records` 时标记 `source: 'queryPower'`，不参与日耗估算。
- 手动查询只更新 `meters.lastRemainingKwh`、`lastQueriedAt`、`failCount`、`lastError` 和 `updatedAt`。
- 手动查询不更新 `estimatedDailyUsageKwh`、`nextCheckAt`、`scheduleMode`、`lastRechargeDetectedAt` 和 `lowPowerNotifiedAt`。
- `scheduledCheck` 是后台采样入口，只有它会更新调度字段、充值检测和低电量周期状态。

## meters 新增字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `estimatedDailyUsageKwh` | number | 该电表估算日耗，默认 `5` kWh/day，最小保护值 `0.5`。 |
| `scheduleMode` | string | 调度状态：`normal`、`near_threshold`、`notified`。 |
| `lastRechargeDetectedAt` | Date | 最近一次由后台采样检测到充值的时间。 |
| `lowPowerNotifiedAt` | Date | 当前低电量周期首次进入提醒状态的时间。 |

## 调度规则

- `saveConfig` 新建电表时设置 `nextCheckAt = new Date()`，由每 2 分钟触发的 `scheduledCheck` 自动完成首次后台采样。
- 每次后台成功查询后，使用后端固定提醒阈值 `20` kWh 计算调度时间。
- 当 `remainingKwh <= 20` 时进入 `notified`，下次查询为 1 天后。
- 当 `remainingKwh - 20 <= 5` 时进入 `near_threshold`，下次查询为 1 天后。
- 其他情况下按线性预测：`(remainingKwh - 20) / estimatedDailyUsageKwh - 2` 天后查询，最短 1 天。
- 若本次后台采样的剩余电量比上一条后台成功采样高至少 `5` kWh，判定为充值，清除当前低电量提醒状态并重新允许下一轮提醒。
- 若用户在当前低电量周期内已经收到过成功发送的邮件，则定时任务不会重复发送同一轮低电量邮件；绑定同一电表的其他用户也统一按 20 kWh 阈值判断提醒。

## 日耗估算

日耗估算只读取 `source: 'scheduledCheck'` 的成功记录。第一次后台采样只作为基线，不更新估算值。

```text
observedDailyUsage = (previousRemainingKwh - currentRemainingKwh) / elapsedDays
```

仅当满足以下条件时更新估算值：

- 本次记录和上一条记录都来自 `scheduledCheck`。
- 两次后台成功采样间隔至少 24 小时，即 `elapsedDays >= 1`。
- 未检测到充值。
- `observedDailyUsage > 0`。

```text
estimatedDailyUsageKwh = oldEstimate * 0.7 + observedDailyUsage * 0.3
```
