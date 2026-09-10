/*
 * 看板运行时入口。
 *
 * 这个文件由 templates/ops/dashboard-template.html 引用，负责把
 * scripts/generate-dashboard-daily.js 生成的本地 JSON 快照加载到页面，
 * 再转换成 KPI、状态分布、电表卡片、通知表格和任务表格。
 *
 * 阅读主线可以按以下顺序进行：
 * 1. 文件顶部的地址、标签和格式化工具；
 * 2. snapshotToDashboard 与 normalizeManifest 这两个数据适配函数；
 * 3. main 函数中的 state 状态对象；
 * 4. render* 函数如何把状态写入 DOM；
 * 5. load/select/refresh 函数如何驱动状态变化；
 * 6. 文件末尾的事件监听和 boot 启动流程。
 */

// 页面由本地预览服务器提供时使用当前 origin；直接打开 HTML 时退回本地默认端口。
const API_BASE_URL = (() => {
  const origin = window.location.origin;
  return origin && origin !== 'null' ? origin : 'http://127.0.0.1:33123';
})();

// 三个接口地址分别对应快照目录、快照索引和“重新生成快照”的 POST 接口。
const SNAPSHOT_API_BASE = `${API_BASE_URL}/snapshots`;
const SNAPSHOT_INDEX_URL = `${SNAPSHOT_API_BASE}/index.json`;
const REFRESH_API_URL = `${API_BASE_URL}/api/refresh`;

// 后端保存的是英文枚举值，页面展示前统一转换为中文。
const TYPE_LABEL = { light: '照明', ac: '空调' };
const STATE_LABEL = { normal: '正常', warn: '预警', monitor: '待检查', error: '异常' };
const JOB_STATUS_LABEL = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败', expired: '已过期' };
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const DETAIL_HISTORY_DAYS = 7;

// 将数字补成两位，例如 3 变成 "03"，用于日期和时间字符串。
function pad2(value) {
  return String(value).padStart(2, '0');
}

// 将外部 JSON 中的字符串安全地放入 innerHTML，避免特殊字符被当成 HTML 解析。
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]|'/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

// 把可转成数字的值格式化为固定小数；无效值用短横线表示。
function formatNumber(value, digits = 1) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '-';
}

// 统一显示时间。快照时间按北京时间（UTC+8）输出，解析失败时保留原文本。
function formatTime(value) {
  if (!value) return '-';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${beijingDate.getUTCFullYear()}-${pad2(beijingDate.getUTCMonth() + 1)}-${pad2(beijingDate.getUTCDate())} ${pad2(beijingDate.getUTCHours())}:${pad2(beijingDate.getUTCMinutes())}:${pad2(beijingDate.getUTCSeconds())}`;
}

// 使用 fetch 读取 JSON。
// async 表示函数返回 Promise，await 会等待网络结果；HTTP 非 2xx 时主动抛错。
async function loadJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`无法加载 ${url}（${response.status}）`);
  }
  return response.json();
}

// 将不同版本或不同来源的电表字段整理为页面统一使用的字段。
// 展开运算符 ...item 先保留原字段，再用下面的标准字段覆盖或补充显示值。
function normalizeMeter(item) {
  const coldStartKnown = item && (item.isColdStart === true || item.isColdStart === false);
  const isColdStart = coldStartKnown ? item.isColdStart : undefined;
  return {
    ...item,
    id: String(item.meterId || item.id || '').trim(),
    type: item.typeText || TYPE_LABEL[item.type === 'ac' ? 'ac' : 'light'],
    current: item.currentText || (Number.isFinite(Number(item.currentKwh)) ? `${formatNumber(item.currentKwh)} kWh` : '-'),
    daily: item.dailyText || (Number.isFinite(Number(item.dailyUsageKwh)) ? `${formatNumber(item.dailyUsageKwh)} kWh` : '-'),
    fail: Number(item.failCount || item.fail) || 0,
    next: formatTime(item.nextCheckAt || item.next),
    state: STATE_LABEL[item.state] ? item.state : 'normal',
    statusText: item.stateText || STATE_LABEL[item.state] || '正常',
    isColdStart,
    coldStartKnown,
    coldStartText: coldStartKnown ? (isColdStart ? '冷启动' : '稳定阶段') : '阶段未知',
  };
}

// 将一个快照适配为看板需要的完整数据结构。
// 这里同时生成 mails：通知记录在后端字段名下更适合存储，页面表格使用更短的显示字段。
function snapshotToDashboard(snapshot) {
  const source = snapshot || {};
  const meters = Array.isArray(source.meters) ? source.meters.map(normalizeMeter) : [];
  const notificationRecords = Array.isArray(source.notificationRecords) ? source.notificationRecords : [];

  return {
    ...source,
    snapshotDate: source.snapshotDate || '',
    kpis: Array.isArray(source.kpis) ? source.kpis : [],
    summary: Array.isArray(source.summary) ? source.summary : [],
    meters,
    mails: notificationRecords.map((item) => ({
      ...item,
      meter: String(item.meterId || '').trim(),
      type: item.typeText || TYPE_LABEL[item.type === 'ac' ? 'ac' : 'light'],
      remain: `${formatNumber(item.remainingKwh)} / ${formatNumber(item.thresholdKwh)} kWh`,
      time: item.sentAt || '',
    })),
    powerRecords: Array.isArray(source.powerRecords) ? source.powerRecords : [],
    notificationRecords,
    jobRecords: Array.isArray(source.jobRecords) ? source.jobRecords : [],
  };
}

// 兼容当前和旧版索引格式，并保证日期按从新到旧排序。
// 索引只描述“有哪些快照”；具体快照内容仍在选择日期后单独加载。
function normalizeManifest(manifest) {
  const source = manifest || {};
  const entries = Array.isArray(source.entries) && source.entries.length
    ? source.entries.slice()
    : (Array.isArray(source.snapshotDates) ? source.snapshotDates.map((snapshotDate) => ({ snapshotDate })) : []);

  const normalizedEntries = entries
    .map((item) => ({
      snapshotDate: String(item.snapshotDate || '').trim(),
      generatedAt: item.generatedAt || '',
      status: item.status || 'success',
      file: item.file || `${String(item.snapshotDate || '').trim()}.json`,
    }))
    .filter((item) => item.snapshotDate)
    .sort((left, right) => String(right.snapshotDate).localeCompare(String(left.snapshotDate)));

  const snapshotDates = normalizedEntries.map((item) => item.snapshotDate);

  return {
    ...source,
    entries: normalizedEntries,
    snapshotDates,
    defaultSnapshotDate: String(source.defaultSnapshotDate || '').trim(),
    latestSuccessfulSnapshotDate: String(source.latestSuccessfulSnapshotDate || '').trim(),
    latestSnapshotDate: String(source.latestSnapshotDate || '').trim(),
    snapshotCount: Number(source.snapshotCount) || normalizedEntries.length,
  };
}

// 以下工具函数负责把 YYYY-MM-DD 快照日期组织成月份和日历。
function getMonthKey(snapshotDate) {
  return String(snapshotDate || '').slice(0, 7);
}

function parseSnapshotDate(snapshotDate) {
  const match = String(snapshotDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return Date.UTC(year, month - 1, day);
}

// Date.UTC 返回毫秒时间戳。使用 UTC 可以避免浏览器本地时区导致日期前后偏移。
function formatSnapshotDateFromTime(value) {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function parseRecordTime(value) {
  if (!value) return 0;
  const parsed = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

// 将 "2026-09" 转成看板中显示的 "2026年9月"。
function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey || '').split('-');
  if (!year || !month) return String(monthKey || '');
  return `${year}年${Number(month)}月`;
}

function getDaysInMonth(monthKey) {
  const [year, month] = String(monthKey || '').split('-').map((value) => Number(value));
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return 0;
  }
  return new Date(year, month, 0).getDate();
}

// JavaScript 的 getDay() 以周日为 0；这里转换为“周一为第一列”的偏移量。
function getCalendarStartOffset(year, month) {
  const weekday = new Date(year, month - 1, 1).getDay();
  return (weekday + 6) % 7;
}

// 建立月份到日期、日期到索引项的 Map，供月份按钮和日历快速查找。
// Map 适合用 key 取值；这里还保留 months 数组，方便按顺序渲染。
function buildSnapshotCatalog(entries) {
  const monthMap = new Map();
  const dateMap = new Map();
  const months = [];

  for (const item of entries || []) {
    if (!item || !item.snapshotDate) {
      continue;
    }

    const snapshotDate = String(item.snapshotDate).trim();
    const monthKey = getMonthKey(snapshotDate);
    if (!monthKey) {
      continue;
    }

    dateMap.set(snapshotDate, item);

    if (!monthMap.has(monthKey)) {
      const [year, month] = monthKey.split('-').map((value) => Number(value));
      const monthState = {
        monthKey,
        label: formatMonthLabel(monthKey),
        year,
        month,
        daysInMonth: getDaysInMonth(monthKey),
        defaultSnapshotDate: snapshotDate,
        availableDates: [],
      };
      monthMap.set(monthKey, monthState);
      months.push(monthState);
    }

    const monthState = monthMap.get(monthKey);
    monthState.availableDates.push(snapshotDate);
  }

  return {
    dateMap,
    monthMap,
    months,
  };
}

// 使用立即执行函数隔离局部变量，避免 state、DOM 引用和内部函数泄漏到全局。
(function main() {
  // state 是页面唯一的运行时状态。数据变化后通常调用 renderAll() 同步刷新界面。
  const state = {
    manifest: normalizeManifest({ entries: [] }),
    dashboard: snapshotToDashboard(null),
    activeSnapshotDate: '',
    activeMonth: '',
    snapshotPickerOpen: false,
    activeMeterId: '',
    activeDetailTab: 'query',
    pagerState: { page: 1, pageSize: 100 },
    snapshotCache: new Map(),
    refreshing: false,
    refreshMessage: '本地离线模式',
    loadError: '',
  };

  // 排序数值越小越靠前，因此异常电表会显示在正常电表之前。
  const meterOrder = { error: 0, warn: 1, monitor: 2, normal: 3 };
  // 这些映射只负责把机器值翻译为人类可读的标签。
  const mailStatusLabel = { sent: '已发送', failed: '发送失败', pending: '待发送', skipped: '已跳过' };
  const mailChannelLabel = { email: '邮件' };

  // 缓存模板中的 DOM 元素。后续 render* 函数直接修改这些元素的文本、属性或 innerHTML。
  const snapshotPicker = document.getElementById('snapshotPicker');
  const snapshotMonthToggle = document.getElementById('snapshotMonthToggle');
  const snapshotMonthLabel = document.getElementById('snapshotMonthLabel');
  const snapshotPickerPanel = document.getElementById('snapshotPickerPanel');
  const snapshotMonthList = document.getElementById('snapshotMonthList');
  const snapshotCalendar = document.getElementById('snapshotCalendar');
  const snapshotUpdatedAt = document.getElementById('snapshotUpdatedAt');
  const snapshotNote = document.getElementById('snapshotNote');
  const refreshDataBtn = document.getElementById('refreshDataBtn');
  const refreshStatus = document.getElementById('refreshStatus');
  const kpiGrid = document.getElementById('kpiGrid');
  const summaryGrid = document.getElementById('summaryGrid');
  const meterMatrix = document.getElementById('meterMatrix');
  const meterGrid = document.getElementById('meterGrid');
  const meterPageMeta = document.getElementById('meterPageMeta');
  const meterPrev = document.getElementById('meterPrev');
  const meterNext = document.getElementById('meterNext');
  const mailTable = document.getElementById('mailTable');
  const jobTable = document.getElementById('jobTable');
  const meterDetailMask = document.getElementById('meterDetailMask');
  const meterDetailTitle = document.getElementById('meterDetailTitle');
  const meterDetailSubtitle = document.getElementById('meterDetailSubtitle');
  const meterDetailSummary = document.getElementById('meterDetailSummary');
  const meterDetailQueryTab = document.getElementById('meterDetailQueryTab');
  const meterDetailNotifyTab = document.getElementById('meterDetailNotifyTab');
  const meterDetailQueryPanel = document.getElementById('meterDetailQueryPanel');
  const meterDetailNotifyPanel = document.getElementById('meterDetailNotifyPanel');
  const meterDetailClose = document.getElementById('meterDetailClose');

  // 返回新的排序数组；slice() 避免 sort() 直接改变 state.dashboard.meters 原数组。
  function getSortedMeters() {
    return state.dashboard.meters.slice().sort((left, right) => {
      const stateDiff = meterOrder[left.state] - meterOrder[right.state];
      if (stateDiff !== 0) return stateDiff;
      return String(left.next).localeCompare(String(right.next));
    });
  }

  // 按优先级选择默认日期：显式默认值 > 最近成功值 > 最近生成值 > 排序后的第一项。
  function getDefaultSnapshotDate(manifest) {
    return manifest.defaultSnapshotDate
      || manifest.latestSuccessfulSnapshotDate
      || manifest.latestSnapshotDate
      || (manifest.entries[0] && manifest.entries[0].snapshotDate)
      || '';
  }

  // 每次根据当前索引重新构造月份目录，避免手动维护多个相互关联的状态。
  function getCatalog() {
    return buildSnapshotCatalog(state.manifest.entries || []);
  }

  // 优先使用当前快照所在月份；如果不存在，则选择索引中的第一个月份。
  function getDefaultMonth(months, snapshotDate) {
    const targetMonth = getMonthKey(snapshotDate);
    if (targetMonth && months.some((item) => item.monthKey === targetMonth)) {
      return targetMonth;
    }
    return months[0] ? months[0].monthKey : '';
  }

  // Set 用来快速判断某一天是否有快照。
  function getMonthAvailableDates(monthState) {
    return new Set((monthState && monthState.availableDates) || []);
  }

  // 确保当前选中的日期确实属于目标月份且存在快照。
  // 月份切换时，如果原日期不适用，就回退到该月默认日期或第一天可用日期。
  function getSafeActiveSnapshotDate(monthState, preferredDate) {
    if (!monthState) return '';
    const availableDates = getMonthAvailableDates(monthState);
    const preferred = String(preferredDate || '').trim();
    if (preferred && availableDates.has(preferred)) {
      return preferred;
    }
    if (monthState.defaultSnapshotDate && availableDates.has(monthState.defaultSnapshotDate)) {
      return monthState.defaultSnapshotDate;
    }
    return monthState.availableDates[0] || '';
  }

  // 从锚点日期向过去寻找最多 7 个“实际存在”的快照日期。
  // 中间缺少某天快照时会跳过，而不是制造一个不存在的文件地址。
  function getRecentSnapshotDates(anchorDate, days = DETAIL_HISTORY_DAYS) {
    const anchorTime = parseSnapshotDate(anchorDate);
    if (anchorTime === null) return [];

    const availableDates = new Set(state.manifest.snapshotDates || []);
    const dates = [];
    const oneDayMs = 24 * 60 * 60 * 1000;

    for (let offset = 0; offset < days; offset += 1) {
      const snapshotDate = formatSnapshotDateFromTime(anchorTime - offset * oneDayMs);
      if (availableDates.has(snapshotDate)) {
        dates.push(snapshotDate);
      }
    }

    return dates;
  }

  // 并发加载近几天快照。Promise.allSettled 会等待全部请求结束，
  // 即使某一天加载失败，也保留其他成功结果，适合展示历史明细。
  async function loadRecentSnapshots(anchorDate) {
    const dates = getRecentSnapshotDates(anchorDate);
    const settled = await Promise.allSettled(dates.map((snapshotDate) => loadSnapshot(snapshotDate)));

    return settled
      .filter((item) => item.status === 'fulfilled' && item.value)
      .map((item) => item.value);
  }

  // 汇总指定电表在近 7 天快照中的查询记录和提醒记录，再按时间倒序展示。
  async function loadMeterRecentDetailRecords(meterId) {
    const snapshots = await loadRecentSnapshots(state.activeSnapshotDate);
    const queryRecords = [];
    const notifyRecords = [];

    for (const snapshot of snapshots) {
      const dashboard = snapshotToDashboard(snapshot);
      queryRecords.push(...dashboard.powerRecords.filter((record) => String(record.meterId || '').trim() === meterId));
      notifyRecords.push(...dashboard.notificationRecords.filter((record) => String(record.meterId || '').trim() === meterId));
    }

    queryRecords.sort((left, right) => parseRecordTime(right.queriedAt) - parseRecordTime(left.queriedAt));
    notifyRecords.sort((left, right) => parseRecordTime(right.sentAt) - parseRecordTime(left.sentAt));

    return { queryRecords, notifyRecords };
  }

  // 生成固定 6 行 × 7 列的日历单元格；不存在的日期使用 empty 占位。
  function getCalendarCells(monthState) {
    if (!monthState || !monthState.monthKey) return [];
    const startOffset = getCalendarStartOffset(monthState.year, monthState.month);
    const totalDays = monthState.daysInMonth;
    const availableDates = getMonthAvailableDates(monthState);
    const cells = [];

    for (let index = 0; index < 42; index += 1) {
      const dayNumber = index - startOffset + 1;
      if (dayNumber < 1 || dayNumber > totalDays) {
        cells.push({ empty: true });
        continue;
      }

      const day = pad2(dayNumber);
      const snapshotDate = `${monthState.monthKey}-${day}`;
      cells.push({
        empty: false,
        dayNumber,
        snapshotDate,
        hasSnapshot: availableDates.has(snapshotDate),
      });
    }

    return cells;
  }

  // 修改刷新提示后立即重绘控制区。
  function setRefreshMessage(message) {
    state.refreshMessage = message || '本地离线模式';
    renderControlState();
  }

  // 只重绘刷新按钮和状态文字，避免更新提示时重建整个页面。
  function renderControlState() {
    refreshStatus.textContent = state.refreshMessage;
    refreshDataBtn.disabled = state.refreshing;
    refreshDataBtn.textContent = state.refreshing ? '更新中...' : '更新数据';
  }

  // 绘制月份选择器和日历。innerHTML 模板字符串用于批量生成重复的按钮结构。
  function renderSnapshotCalendar() {
    const catalog = getCatalog();
    const months = catalog.months || [];

    if (!months.length) {
      snapshotMonthToggle.disabled = true;
      snapshotMonthToggle.setAttribute('aria-expanded', 'false');
      snapshotMonthLabel.textContent = '暂无本地快照';
      snapshotPicker.classList.remove('open');
      snapshotPickerPanel.hidden = true;
      snapshotMonthList.innerHTML = '';
      snapshotCalendar.innerHTML = '<div class="calendar-empty">暂无本地快照</div>';
      return;
    }

    const fallbackDate = getDefaultSnapshotDate(state.manifest);
    const defaultMonth = getDefaultMonth(months, state.activeSnapshotDate || fallbackDate);
    state.activeMonth = months.some((item) => item.monthKey === state.activeMonth) ? state.activeMonth : defaultMonth;
    const activeMonthKey = state.activeMonth || defaultMonth || months[0].monthKey;
    const monthState = catalog.monthMap.get(activeMonthKey);
    const activeDate = getSafeActiveSnapshotDate(monthState, state.activeSnapshotDate || fallbackDate);
    state.activeSnapshotDate = activeDate;
    state.activeMonth = activeMonthKey;

    snapshotMonthToggle.disabled = false;
    snapshotMonthToggle.setAttribute('aria-expanded', String(Boolean(state.snapshotPickerOpen)));
    snapshotMonthLabel.textContent = monthState ? monthState.label : '';
    snapshotPicker.classList.toggle('open', Boolean(state.snapshotPickerOpen));
    snapshotPickerPanel.hidden = !state.snapshotPickerOpen;
    snapshotMonthList.innerHTML = months.map((item) => `
      <button
        class="snapshot-month-item ${item.monthKey === state.activeMonth ? 'active' : ''}"
        type="button"
        data-month-key="${escapeHtml(item.monthKey)}"
        aria-pressed="${item.monthKey === state.activeMonth ? 'true' : 'false'}"
      >
        ${escapeHtml(item.label)}
      </button>
    `).join('');

    const cells = getCalendarCells(monthState);
    snapshotCalendar.innerHTML = `
      <div class="calendar-head">
        ${WEEKDAY_LABELS.map((label) => `<span class="calendar-weekday">${label}</span>`).join('')}
      </div>
      <div class="calendar-grid">
        ${cells.map((cell) => {
          if (cell.empty) {
            return '<button class="calendar-cell empty" type="button" disabled></button>';
          }
          const isActive = cell.snapshotDate === state.activeSnapshotDate;
          const isAvailable = cell.hasSnapshot;
          return `
            <button
            class="calendar-cell ${isAvailable ? 'available' : 'disabled'} ${isActive ? 'active' : ''}"
              type="button"
              data-snapshot-date="${escapeHtml(cell.snapshotDate)}"
              title="${isAvailable ? '点击查看该日快照' : '当天没有快照'}"
              aria-label="${escapeHtml(`${cell.snapshotDate}${isAvailable ? '，有快照' : '，无快照'}`)}"
              ${isAvailable ? '' : 'disabled'}
            >
              <span class="calendar-day">${cell.dayNumber}</span>
              <span class="calendar-dot">${isAvailable ? '有' : '无'}</span>
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderHeaderMeta() {
    if (!state.dashboard.snapshotDate) {
      snapshotNote.textContent = state.loadError ? `当前快照 · ${state.loadError}` : '当前快照 · 暂无数据';
      snapshotUpdatedAt.textContent = state.manifest.generatedAt ? `索引更新时间 ${formatTime(state.manifest.generatedAt)}` : '更新时间 -';
      return;
    }

    snapshotNote.textContent = `当前快照 · ${state.dashboard.snapshotDate}${state.dashboard.status && state.dashboard.status !== 'success' ? ` · ${state.dashboard.status}` : ''}`;
    snapshotUpdatedAt.textContent = state.dashboard.generatedAt ? `更新时间 ${formatTime(state.dashboard.generatedAt)}` : '更新时间 -';
  }

  // 绘制顶部 KPI。没有快照时显示占位内容，而不是让空白区域误解为“数据为 0”。
  function renderKpis() {
    kpiGrid.innerHTML = state.dashboard.kpis.length
      ? state.dashboard.kpis.map((item) => `<div class="kpi"><div class="kpi-label">${escapeHtml(item.label)}</div><div class="kpi-value">${escapeHtml(item.value)}</div><div class="kpi-foot">${escapeHtml(item.foot)}</div></div>`).join('')
      : '<div class="kpi"><div class="kpi-label">暂无快照</div><div class="kpi-value">-</div><div class="kpi-foot">等待本地快照文件</div></div>';
  }

  // 绘制正常、预警、待检查、异常四类状态的数量摘要。
  function renderSummary() {
    summaryGrid.innerHTML = state.dashboard.summary.length
      ? state.dashboard.summary.map((item) => `<div class="summary-card ${item.key}"><h3>${escapeHtml(item.title)}</h3><div class="count">${escapeHtml(item.count)}</div><div class="note">${escapeHtml(item.note)}</div></div>`).join('')
      : '<div class="summary-card monitor"><h3>暂无分布</h3><div class="count">-</div><div class="note">等待快照数据</div></div>';
  }

  // 绘制电表状态矩阵。每个小方块只承担状态概览，详细信息放在下面的卡片中。
  function renderMeterMatrix(meters) {
    meterMatrix.innerHTML = meters.length
      ? meters.map((item) => `<span class="meter-tile ${item.state}" title="${escapeHtml(`${item.id} · ${item.type} · ${item.statusText}${item.coldStartKnown ? ` · ${item.coldStartText}` : ''}`)}" aria-label="${escapeHtml(item.id)}"></span>`).join('')
      : '<div class="meter-detail-empty">当前快照没有电表数据。</div>';
  }

  // 按当前页绘制电表卡片，并同步上一页/下一页按钮的可用状态。
  // pageSize 当前为 100，主要用于数据量较大时避免一次渲染过多 DOM。
  function renderMeterCards(meters) {
    if (!meters.length) {
      meterGrid.innerHTML = '<div class="meter-detail-empty">当前快照没有电表卡片数据。</div>';
      meterPageMeta.textContent = '当前没有电表数据';
      meterPrev.disabled = true;
      meterNext.disabled = true;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(meters.length / state.pagerState.pageSize));
    state.pagerState.page = Math.min(Math.max(state.pagerState.page, 1), totalPages);
    const start = (state.pagerState.page - 1) * state.pagerState.pageSize;
    const pageRows = meters.slice(start, start + state.pagerState.pageSize);

    meterGrid.innerHTML = pageRows.map((item) => `
      <article class="meter-card ${item.state}" role="button" tabindex="0" data-meter-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.id)} 电表详情">
        <div class="meter-head">
          <div>
            <div class="meter-id">${escapeHtml(item.id)}</div>
            <div class="meter-type">类型：${escapeHtml(item.type)}</div>
          </div>
          <div class="meter-head-badges">
            ${item.isColdStart === true ? '<span class="cold-start-badge">冷启动</span>' : ''}
            <span class="status-pill ${item.state}">${escapeHtml(item.statusText)}</span>
          </div>
        </div>
        <div class="meter-stats">
          <div class="stat"><div class="stat-label">当前电量</div><div class="stat-value">${escapeHtml(item.current)}</div></div>
          <div class="stat"><div class="stat-label">日耗</div><div class="stat-value">${escapeHtml(item.daily)}</div></div>
          <div class="stat"><div class="stat-label">失败次数</div><div class="stat-value">${escapeHtml(`${item.fail} 次`)}</div></div>
          <div class="stat"><div class="stat-label">下次检查时间</div><div class="stat-value">${escapeHtml(item.next)}</div></div>
        </div>
      </article>
    `).join('');

    meterPageMeta.textContent = `第 ${state.pagerState.page} / ${totalPages} 页 · ${start + 1}-${start + pageRows.length} / ${meters.length}`;
    meterPrev.disabled = state.pagerState.page <= 1;
    meterNext.disabled = state.pagerState.page >= totalPages;
  }

  // 将通知记录绘制为表格行；所有来自 JSON 的值先经过 escapeHtml。
  function renderMailTable() {
    mailTable.innerHTML = state.dashboard.mails.length
      ? state.dashboard.mails.map((item) => `
        <tr>
          <td class="table-meter">${escapeHtml(item.meter)}</td>
          <td>${escapeHtml(item.type)}</td>
          <td>${escapeHtml(item.remain)}</td>
          <td><span class="tag ${item.status}">${escapeHtml(mailStatusLabel[item.status] || item.status)}</span></td>
          <td>${escapeHtml(mailChannelLabel[item.channel] || item.channel)}</td>
          <td class="table-time">${escapeHtml(formatTime(item.time))}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="6">当前快照没有提醒通知记录。</td></tr>';
  }

  // 将定时任务执行记录绘制为表格行，并把任务状态映射为对应的 CSS class。
  function renderJobTable() {
    jobTable.innerHTML = state.dashboard.jobRecords.length
      ? state.dashboard.jobRecords.map((item) => `
        <tr>
          <td>${escapeHtml(item.jobId || '-')}</td>
          <td class="table-meter">${escapeHtml(item.meterId || '-')}</td>
          <td>${escapeHtml(TYPE_LABEL[item.type] || item.type || '-')}</td>
          <td><span class="tag ${item.status === 'done' ? 'done' : item.status === 'running' ? 'running' : item.status === 'expired' ? 'expired' : item.status === 'failed' ? 'failed' : 'pending'}">${escapeHtml(item.statusText || JOB_STATUS_LABEL[item.status] || item.status)}</span></td>
          <td class="table-time">${escapeHtml(formatTime(item.plannedAt))}</td>
          <td class="table-time">${escapeHtml(formatTime(item.finishedAt))}</td>
          <td>${escapeHtml(String(item.attempts || 0))}</td>
          <td>${escapeHtml(item.error || '-')}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="8">当前快照没有任务记录。</td></tr>';
  }

  // 绘制明细弹窗的标题、摘要指标和副标题。
  function renderDetailShell(item, subtitle) {
    meterDetailTitle.textContent = `${item.id} 电表详情`;
    meterDetailSubtitle.textContent = subtitle;
    meterDetailSummary.innerHTML = `
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">当前电量</div><div class="meter-detail-summary-value">${escapeHtml(item.current)}</div></div>
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">日耗</div><div class="meter-detail-summary-value">${escapeHtml(item.daily)}</div></div>
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">失败次数</div><div class="meter-detail-summary-value">${escapeHtml(`${item.fail} 次`)}</div></div>
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">下次检查时间</div><div class="meter-detail-summary-value">${escapeHtml(item.next)}</div></div>
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">估算阶段</div><div class="meter-detail-summary-value">${escapeHtml(item.coldStartText)}</div></div>
    `;
  }

  // 根据 state.activeDetailTab 切换两个明细面板的显示状态。
  function renderDetailTabs() {
    meterDetailQueryTab.classList.toggle('active', state.activeDetailTab === 'query');
    meterDetailNotifyTab.classList.toggle('active', state.activeDetailTab === 'notify');
    meterDetailQueryPanel.hidden = state.activeDetailTab !== 'query';
    meterDetailNotifyPanel.hidden = state.activeDetailTab !== 'notify';
  }

  // 绘制弹窗中的查询记录和提醒记录。
  // 三元表达式 condition ? A : B 用于在“有数据”和“空状态”之间选择 HTML。
  function renderDetailRecords(queryRecords, notifyRecords) {
    meterDetailQueryPanel.innerHTML = queryRecords.length
      ? `<div class="meter-detail-record-list">${queryRecords.map((record) => `
        <article class="meter-detail-record ${record.ok ? '' : 'failed'}">
          <div><div class="meter-detail-record-label">查询时间</div><div class="meter-detail-record-value">${escapeHtml(formatTime(record.queriedAt))}</div></div>
          <div><div class="meter-detail-record-label">剩余电量</div><div class="meter-detail-record-value">${escapeHtml(record.remainingKwh === undefined ? '-' : `${formatNumber(record.remainingKwh)} kWh`)}</div></div>
          <div><div class="meter-detail-record-label">结果</div><div class="meter-detail-record-value"><span class="tag ${record.ok ? 'sent' : 'failed'}">${record.ok ? '成功' : '失败'}</span></div></div>
          <div><div class="meter-detail-record-label">详情</div><div class="meter-detail-record-note">来源：${escapeHtml(record.source || '-')} · 截止：${escapeHtml(record.cutoffTime || '-')} · 地址：${escapeHtml(record.address || '-')}</div></div>
        </article>
      `).join('')}</div>`
      : '<div class="meter-detail-empty">近 7 天没有查询记录。</div>';

    meterDetailNotifyPanel.innerHTML = notifyRecords.length
      ? `<div class="meter-detail-record-list">${notifyRecords.map((record) => `
        <article class="meter-detail-record ${record.status === 'failed' ? 'failed' : ''}">
          <div><div class="meter-detail-record-label">发送时间</div><div class="meter-detail-record-value">${escapeHtml(formatTime(record.sentAt))}</div></div>
          <div><div class="meter-detail-record-label">余量/阈值</div><div class="meter-detail-record-value">${escapeHtml(`${formatNumber(record.remainingKwh)} / ${formatNumber(record.thresholdKwh)} kWh`)}</div></div>
          <div><div class="meter-detail-record-label">状态</div><div class="meter-detail-record-value"><span class="tag ${record.status}">${escapeHtml(mailStatusLabel[record.status] || record.status)}</span></div></div>
          <div><div class="meter-detail-record-label">详情</div><div class="meter-detail-record-note">渠道：${escapeHtml(mailChannelLabel[record.channel] || record.channel)} · 来源：${escapeHtml(record.source || '-')}</div></div>
        </article>
      `).join('')}</div>`
      : '<div class="meter-detail-empty">近 7 天没有提醒通知。</div>';

    renderDetailTabs();
  }

  // 异步请求尚未结束时先显示加载状态，避免用户误以为弹窗没有响应。
  function renderDetailLoading(item) {
    renderDetailShell(item, `当前状态：${item.statusText}，估算阶段：${item.coldStartText}，正在加载近 7 天查询记录和提醒通知。`);
    meterDetailQueryPanel.innerHTML = '<div class="meter-detail-empty">正在加载近 7 天查询记录...</div>';
    meterDetailNotifyPanel.innerHTML = '<div class="meter-detail-empty">正在加载近 7 天提醒通知...</div>';
    renderDetailTabs();
  }

  // 加载并绘制弹窗明细。
  // 请求返回后再次检查当前电表和弹窗状态，防止较慢的旧请求覆盖用户刚打开的新内容。
  async function renderDetail(item) {
    renderDetailLoading(item);

    try {
      const { queryRecords, notifyRecords } = await loadMeterRecentDetailRecords(item.id);
      if (state.activeMeterId !== item.id || meterDetailMask.hidden) {
        return;
      }

      renderDetailShell(item, `当前状态：${item.statusText}，估算阶段：${item.coldStartText}，近 7 天查询记录 ${queryRecords.length} 条，提醒记录 ${notifyRecords.length} 条。`);
      renderDetailRecords(queryRecords, notifyRecords);
    } catch (error) {
      if (state.activeMeterId !== item.id || meterDetailMask.hidden) {
        return;
      }

      renderDetailShell(item, `当前状态：${item.statusText}，估算阶段：${item.coldStartText}，近 7 天明细加载失败。`);
      meterDetailQueryPanel.innerHTML = `<div class="meter-detail-empty">近 7 天查询记录加载失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
      meterDetailNotifyPanel.innerHTML = `<div class="meter-detail-empty">近 7 天提醒通知加载失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
      renderDetailTabs();
    }
  }

  // 打开弹窗前记录当前电表，并使用 void 忽略异步函数返回的 Promise。
  function openMeterDetail(item) {
    state.activeMeterId = item.id;
    state.activeDetailTab = 'query';
    meterDetailMask.hidden = false;
    void renderDetail(item);
  }

  // 关闭弹窗并清空当前电表标识；清空标识也会使尚未完成的旧请求失效。
  function closeMeterDetail() {
    meterDetailMask.hidden = true;
    state.activeMeterId = '';
  }

  // 按统一顺序重绘所有看板区域。数据状态改变后由这里作为页面刷新入口。
  function renderAll() {
    const meters = getSortedMeters();
    renderSnapshotCalendar();
    renderHeaderMeta();
    renderControlState();
    renderKpis();
    renderSummary();
    renderMeterMatrix(meters);
    renderMeterCards(meters);
    renderMailTable();
    renderJobTable();
  }

  // 首次加载索引文件。索引变化后会更新 state.manifest。
  async function loadManifest() {
    const manifest = normalizeManifest(await loadJson(`${SNAPSHOT_INDEX_URL}?t=${Date.now()}`));
    state.manifest = manifest;
    return manifest;
  }

  // 按日期加载单个快照，并用 Map 缓存已经成功加载的结果。
  // 缓存避免切换月份或打开明细时重复请求同一个 JSON。
  async function loadSnapshot(snapshotDate) {
    if (!snapshotDate) return null;

    if (state.snapshotCache.has(snapshotDate)) {
      return state.snapshotCache.get(snapshotDate);
    }

    const snapshot = await loadJson(`${SNAPSHOT_API_BASE}/${encodeURIComponent(snapshotDate)}.json?t=${Date.now()}`);
    state.snapshotCache.set(snapshotDate, snapshot);
    return snapshot;
  }

  // 从月份目录中取出指定月份的完整状态。
  function getMonthState(monthKey) {
    const catalog = getCatalog();
    return catalog.monthMap.get(String(monthKey || '').trim()) || null;
  }

  // 切换月份，并尽量保留该月份中合理的当前日期。
  async function selectMonth(monthKey) {
    const nextMonthKey = String(monthKey || '').trim();
    const monthState = getMonthState(nextMonthKey);
    if (!monthState) {
      renderSnapshotCalendar();
      return;
    }

    state.snapshotPickerOpen = false;
    state.activeMonth = nextMonthKey;
    const targetDate = getSafeActiveSnapshotDate(monthState, state.activeSnapshotDate || getDefaultSnapshotDate(state.manifest));
    if (targetDate) {
      await selectSnapshot(targetDate);
      return;
    }

    renderSnapshotCalendar();
  }

  // 切换具体快照。成功时更新看板数据；失败时清空数据并保留错误提示。
  async function selectSnapshot(snapshotDate) {
    const nextSnapshotDate = String(snapshotDate || '').trim();
    if (!nextSnapshotDate) {
      state.dashboard = snapshotToDashboard(null);
      state.activeSnapshotDate = '';
      state.activeMonth = '';
      state.snapshotPickerOpen = false;
      state.loadError = '';
      state.activeMeterId = '';
      state.activeDetailTab = 'query';
      state.pagerState.page = 1;
      closeMeterDetail();
      renderAll();
      return;
    }

    try {
      const snapshot = await loadSnapshot(nextSnapshotDate);
      if (!snapshot) throw new Error(`未找到 ${nextSnapshotDate} 的本地快照文件`);

      state.dashboard = snapshotToDashboard(snapshot);
      state.activeSnapshotDate = nextSnapshotDate;
      state.activeMonth = getMonthKey(nextSnapshotDate);
      state.snapshotPickerOpen = false;
      state.loadError = '';
      state.activeMeterId = '';
      state.activeDetailTab = 'query';
      state.pagerState.page = 1;
      closeMeterDetail();
      renderAll();
    } catch (error) {
      state.dashboard = snapshotToDashboard(null);
      state.activeSnapshotDate = '';
      state.activeMonth = '';
      state.snapshotPickerOpen = false;
      state.loadError = error instanceof Error ? error.message : String(error);
      state.activeMeterId = '';
      state.activeDetailTab = 'query';
      state.pagerState.page = 1;
      closeMeterDetail();
      renderAll();
    }
  }

  // 调用本地服务重新生成快照，再重新读取索引和当前快照。
  // refreshing 既防止重复点击，也让按钮进入“更新中”状态。
  async function refreshData() {
    if (state.refreshing) return;

    state.refreshing = true;
    setRefreshMessage('正在更新数据...');

    try {
      const response = await fetch(REFRESH_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `更新失败（${response.status}）`);
      }

      const freshManifest = normalizeManifest(await loadJson(`${SNAPSHOT_INDEX_URL}?t=${Date.now()}`));
      state.manifest = freshManifest;
      state.snapshotCache.clear();

      const preferredDate = state.activeSnapshotDate && freshManifest.snapshotDates.includes(state.activeSnapshotDate)
        ? state.activeSnapshotDate
        : getDefaultSnapshotDate(freshManifest);

      setRefreshMessage(`已更新 ${formatTime(payload.generatedAt || new Date().toISOString())}`);

      if (preferredDate) {
        await selectSnapshot(preferredDate);
      } else {
        renderAll();
      }
    } catch (error) {
      setRefreshMessage(`更新失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      state.refreshing = false;
      renderControlState();
    }
  }

  // 页面启动流程：先绘制空状态，再加载索引，最后选择默认快照。
  async function boot() {
    renderAll();

    try {
      await loadManifest();
      state.loadError = '';
      const initialDate = getDefaultSnapshotDate(state.manifest);
      if (initialDate) {
        await selectSnapshot(initialDate);
      } else {
        setRefreshMessage('暂无本地快照');
        renderAll();
      }
    } catch (error) {
      state.manifest = normalizeManifest({ entries: [] });
      state.dashboard = snapshotToDashboard(null);
      state.loadError = error instanceof Error ? error.message : String(error);
      setRefreshMessage('本地预览服务未启动');
      renderAll();
    }
  }

  // 月份按钮：打开或关闭月份选择器。
  snapshotMonthToggle.addEventListener('click', () => {
    if (snapshotMonthToggle.disabled) {
      return;
    }
    state.snapshotPickerOpen = !state.snapshotPickerOpen;
    renderSnapshotCalendar();
  });

  // 事件委托：月份列表本身只绑定一次，实际点击的按钮从 event.target 向上查找。
  snapshotMonthList.addEventListener('click', (event) => {
    const button = event.target.closest('.snapshot-month-item');
    if (!button || button.disabled || !button.dataset.monthKey) {
      return;
    }
    void selectMonth(button.dataset.monthKey);
  });

  // 事件委托：日历中的可用日期按钮触发快照切换。
  snapshotCalendar.addEventListener('click', (event) => {
    const cell = event.target.closest('.calendar-cell');
    if (!cell || cell.disabled || !cell.dataset.snapshotDate) {
      return;
    }
    void selectSnapshot(cell.dataset.snapshotDate);
  });

  // 点击选择器外部时关闭选择器。
  document.addEventListener('click', (event) => {
    if (!state.snapshotPickerOpen || !snapshotPicker || snapshotPicker.contains(event.target)) {
      return;
    }
    state.snapshotPickerOpen = false;
    renderSnapshotCalendar();
  });

  // “更新数据”按钮启动异步刷新。
  refreshDataBtn.addEventListener('click', () => {
    void refreshData();
  });

  // 分页按钮只修改页码，然后重绘当前电表卡片。
  meterPrev.addEventListener('click', () => {
    if (state.pagerState.page > 1) {
      state.pagerState.page -= 1;
      renderMeterCards(getSortedMeters());
    }
  });

  meterNext.addEventListener('click', () => {
    const meters = getSortedMeters();
    const totalPages = Math.max(1, Math.ceil(meters.length / state.pagerState.pageSize));
    if (state.pagerState.page < totalPages) {
      state.pagerState.page += 1;
      renderMeterCards(meters);
    }
  });

  // 电表卡片使用事件委托，支持鼠标点击打开明细。
  meterGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.meter-card');
    if (!card) return;
    const item = getSortedMeters().find((meter) => meter.id === card.dataset.meterId);
    if (item) openMeterDetail(item);
  });

  // 同时支持键盘 Enter/空格打开卡片，保证 role="button" 元素可访问。
  meterGrid.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('meter-card')) {
      event.preventDefault();
      const item = getSortedMeters().find((meter) => meter.id === event.target.dataset.meterId);
      if (item) openMeterDetail(item);
    }
  });

  // 弹窗支持关闭按钮、点击遮罩、两个明细页签和 Escape 键。
  meterDetailClose.addEventListener('click', closeMeterDetail);
  meterDetailMask.addEventListener('click', (event) => {
    if (event.target === meterDetailMask) closeMeterDetail();
  });
  meterDetailQueryTab.addEventListener('click', () => {
    state.activeDetailTab = 'query';
    renderDetailTabs();
  });
  meterDetailNotifyTab.addEventListener('click', () => {
    state.activeDetailTab = 'notify';
    renderDetailTabs();
  });
  document.addEventListener('keydown', (event) => {
    if (state.snapshotPickerOpen && event.key === 'Escape') {
      state.snapshotPickerOpen = false;
      renderSnapshotCalendar();
      return;
    }
    if (!meterDetailMask.hidden && event.key === 'Escape') closeMeterDetail();
  });

  // 启动函数本身是异步的；这里用 void 表示有意忽略其 Promise 返回值。
  void boot();
}());
