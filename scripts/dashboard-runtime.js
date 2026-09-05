const API_BASE_URL = (() => {
  const origin = window.location.origin;
  return origin && origin !== 'null' ? origin : 'http://127.0.0.1:33123';
})();

const SNAPSHOT_API_BASE = `${API_BASE_URL}/snapshots`;
const SNAPSHOT_INDEX_URL = `${SNAPSHOT_API_BASE}/index.json`;
const REFRESH_API_URL = `${API_BASE_URL}/api/refresh`;

const TYPE_LABEL = { light: '照明', ac: '空调' };
const STATE_LABEL = { normal: '正常', warn: '预警', monitor: '待检查', error: '异常' };
const JOB_STATUS_LABEL = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败', expired: '已过期' };

function pad2(value) {
  return String(value).padStart(2, '0');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]|'/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '-';
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${beijingDate.getUTCFullYear()}-${pad2(beijingDate.getUTCMonth() + 1)}-${pad2(beijingDate.getUTCDate())} ${pad2(beijingDate.getUTCHours())}:${pad2(beijingDate.getUTCMinutes())}:${pad2(beijingDate.getUTCSeconds())}`;
}

async function loadJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`无法加载 ${url}（${response.status}）`);
  }
  return response.json();
}

function normalizeMeter(item) {
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
  };
}

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

(function main() {
  const state = {
    manifest: normalizeManifest({ entries: [] }),
    dashboard: snapshotToDashboard(null),
    activeSnapshotDate: '',
    activeMeterId: '',
    activeDetailTab: 'query',
    pagerState: { page: 1, pageSize: 100 },
    snapshotCache: new Map(),
    refreshing: false,
    refreshMessage: '本地离线模式',
    loadError: '',
  };

  const meterOrder = { error: 0, warn: 1, monitor: 2, normal: 3 };
  const mailStatusLabel = { sent: '已发送', failed: '发送失败', pending: '待发送', skipped: '已跳过' };
  const mailChannelLabel = { email: '邮件' };

  const snapshotDateSelect = document.getElementById('snapshotDateSelect');
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

  function getSortedMeters() {
    return state.dashboard.meters.slice().sort((left, right) => {
      const stateDiff = meterOrder[left.state] - meterOrder[right.state];
      if (stateDiff !== 0) return stateDiff;
      return String(left.next).localeCompare(String(right.next));
    });
  }

  function getDefaultSnapshotDate(manifest) {
    return manifest.defaultSnapshotDate
      || manifest.latestSuccessfulSnapshotDate
      || manifest.latestSnapshotDate
      || (manifest.entries[0] && manifest.entries[0].snapshotDate)
      || '';
  }

  function setRefreshMessage(message) {
    state.refreshMessage = message || '本地离线模式';
    renderControlState();
  }

  function renderControlState() {
    refreshStatus.textContent = state.refreshMessage;
    refreshDataBtn.disabled = state.refreshing;
    refreshDataBtn.textContent = state.refreshing ? '更新中...' : '更新数据';
  }

  function renderSnapshotSelector() {
    const entries = state.manifest.entries || [];
    if (!entries.length) {
      snapshotDateSelect.innerHTML = '<option value="">暂无本地快照</option>';
      snapshotDateSelect.disabled = true;
      snapshotDateSelect.value = '';
      return;
    }

    snapshotDateSelect.disabled = false;
    snapshotDateSelect.innerHTML = entries.map((item) => `<option value="${item.snapshotDate}">${escapeHtml(item.snapshotDate)}</option>`).join('');
    snapshotDateSelect.value = state.activeSnapshotDate || getDefaultSnapshotDate(state.manifest) || entries[0].snapshotDate;
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

  function renderKpis() {
    kpiGrid.innerHTML = state.dashboard.kpis.length
      ? state.dashboard.kpis.map((item) => `<div class="kpi"><div class="kpi-label">${escapeHtml(item.label)}</div><div class="kpi-value">${escapeHtml(item.value)}</div><div class="kpi-foot">${escapeHtml(item.foot)}</div></div>`).join('')
      : '<div class="kpi"><div class="kpi-label">暂无快照</div><div class="kpi-value">-</div><div class="kpi-foot">等待本地快照文件</div></div>';
  }

  function renderSummary() {
    summaryGrid.innerHTML = state.dashboard.summary.length
      ? state.dashboard.summary.map((item) => `<div class="summary-card ${item.key}"><h3>${escapeHtml(item.title)}</h3><div class="count">${escapeHtml(item.count)}</div><div class="note">${escapeHtml(item.note)}</div></div>`).join('')
      : '<div class="summary-card monitor"><h3>暂无分布</h3><div class="count">-</div><div class="note">等待快照数据</div></div>';
  }

  function renderMeterMatrix(meters) {
    meterMatrix.innerHTML = meters.length
      ? meters.map((item) => `<span class="meter-tile ${item.state}" title="${escapeHtml(`${item.id} · ${item.type} · ${item.statusText}`)}" aria-label="${escapeHtml(item.id)}"></span>`).join('')
      : '<div class="meter-detail-empty">当前快照没有电表数据。</div>';
  }

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
          <span class="status-pill ${item.state}">${escapeHtml(item.statusText)}</span>
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

  function renderDetail(item) {
    const queryRecords = state.dashboard.powerRecords
      .filter((record) => record.meterId === item.id)
      .slice()
      .sort((left, right) => String(right.queriedAt).localeCompare(String(left.queriedAt)));
    const notifyRecords = state.dashboard.notificationRecords
      .filter((record) => record.meterId === item.id)
      .slice()
      .sort((left, right) => String(right.sentAt).localeCompare(String(left.sentAt)));

    meterDetailTitle.textContent = `${item.id} 电表详情`;
    meterDetailSubtitle.textContent = `当前状态：${item.statusText}，查询记录 ${queryRecords.length} 条，提醒记录 ${notifyRecords.length} 条。`;
    meterDetailSummary.innerHTML = `
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">当前电量</div><div class="meter-detail-summary-value">${escapeHtml(item.current)}</div></div>
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">日耗</div><div class="meter-detail-summary-value">${escapeHtml(item.daily)}</div></div>
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">失败次数</div><div class="meter-detail-summary-value">${escapeHtml(`${item.fail} 次`)}</div></div>
      <div class="meter-detail-summary-item"><div class="meter-detail-summary-label">下次检查时间</div><div class="meter-detail-summary-value">${escapeHtml(item.next)}</div></div>
    `;

    meterDetailQueryPanel.innerHTML = queryRecords.length
      ? `<div class="meter-detail-record-list">${queryRecords.map((record) => `
        <article class="meter-detail-record ${record.ok ? '' : 'failed'}">
          <div><div class="meter-detail-record-label">查询时间</div><div class="meter-detail-record-value">${escapeHtml(formatTime(record.queriedAt))}</div></div>
          <div><div class="meter-detail-record-label">剩余电量</div><div class="meter-detail-record-value">${escapeHtml(record.remainingKwh === undefined ? '-' : `${formatNumber(record.remainingKwh)} kWh`)}</div></div>
          <div><div class="meter-detail-record-label">结果</div><div class="meter-detail-record-value"><span class="tag ${record.ok ? 'sent' : 'failed'}">${record.ok ? '成功' : '失败'}</span></div></div>
          <div><div class="meter-detail-record-label">详情</div><div class="meter-detail-record-note">来源：${escapeHtml(record.source || '-')} · 截止：${escapeHtml(record.cutoffTime || '-')} · 地址：${escapeHtml(record.address || '-')}</div></div>
        </article>
      `).join('')}</div>`
      : '<div class="meter-detail-empty">当前电表没有相关记录。</div>';

    meterDetailNotifyPanel.innerHTML = notifyRecords.length
      ? `<div class="meter-detail-record-list">${notifyRecords.map((record) => `
        <article class="meter-detail-record ${record.status === 'failed' ? 'failed' : ''}">
          <div><div class="meter-detail-record-label">发送时间</div><div class="meter-detail-record-value">${escapeHtml(formatTime(record.sentAt))}</div></div>
          <div><div class="meter-detail-record-label">余量/阈值</div><div class="meter-detail-record-value">${escapeHtml(`${formatNumber(record.remainingKwh)} / ${formatNumber(record.thresholdKwh)} kWh`)}</div></div>
          <div><div class="meter-detail-record-label">状态</div><div class="meter-detail-record-value"><span class="tag ${record.status}">${escapeHtml(mailStatusLabel[record.status] || record.status)}</span></div></div>
          <div><div class="meter-detail-record-label">详情</div><div class="meter-detail-record-note">渠道：${escapeHtml(mailChannelLabel[record.channel] || record.channel)} · 来源：${escapeHtml(record.source || '-')}</div></div>
        </article>
      `).join('')}</div>`
      : '<div class="meter-detail-empty">当前电表没有相关记录。</div>';

    meterDetailQueryTab.classList.toggle('active', state.activeDetailTab === 'query');
    meterDetailNotifyTab.classList.toggle('active', state.activeDetailTab === 'notify');
    meterDetailQueryPanel.hidden = state.activeDetailTab !== 'query';
    meterDetailNotifyPanel.hidden = state.activeDetailTab !== 'notify';
  }

  function openMeterDetail(item) {
    state.activeMeterId = item.id;
    state.activeDetailTab = 'query';
    meterDetailMask.hidden = false;
    renderDetail(item);
  }

  function closeMeterDetail() {
    meterDetailMask.hidden = true;
    state.activeMeterId = '';
  }

  function renderAll() {
    const meters = getSortedMeters();
    renderSnapshotSelector();
    renderHeaderMeta();
    renderControlState();
    renderKpis();
    renderSummary();
    renderMeterMatrix(meters);
    renderMeterCards(meters);
    renderMailTable();
    renderJobTable();
  }

  async function loadManifest() {
    const manifest = normalizeManifest(await loadJson(`${SNAPSHOT_INDEX_URL}?t=${Date.now()}`));
    state.manifest = manifest;
    return manifest;
  }

  async function loadSnapshot(snapshotDate) {
    if (!snapshotDate) return null;

    if (state.snapshotCache.has(snapshotDate)) {
      return state.snapshotCache.get(snapshotDate);
    }

    const snapshot = await loadJson(`${SNAPSHOT_API_BASE}/${encodeURIComponent(snapshotDate)}.json?t=${Date.now()}`);
    state.snapshotCache.set(snapshotDate, snapshot);
    return snapshot;
  }

  async function selectSnapshot(snapshotDate) {
    const nextSnapshotDate = String(snapshotDate || '').trim();
    if (!nextSnapshotDate) {
      state.dashboard = snapshotToDashboard(null);
      state.activeSnapshotDate = '';
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
      state.loadError = '';
      state.activeMeterId = '';
      state.activeDetailTab = 'query';
      state.pagerState.page = 1;
      closeMeterDetail();
      renderAll();
    } catch (error) {
      state.dashboard = snapshotToDashboard(null);
      state.activeSnapshotDate = '';
      state.loadError = error instanceof Error ? error.message : String(error);
      state.activeMeterId = '';
      state.activeDetailTab = 'query';
      state.pagerState.page = 1;
      closeMeterDetail();
      renderAll();
    }
  }

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

  snapshotDateSelect.addEventListener('change', () => {
    void selectSnapshot(snapshotDateSelect.value);
  });

  refreshDataBtn.addEventListener('click', () => {
    void refreshData();
  });

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

  meterGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.meter-card');
    if (!card) return;
    const item = getSortedMeters().find((meter) => meter.id === card.dataset.meterId);
    if (item) openMeterDetail(item);
  });

  meterGrid.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('meter-card')) {
      event.preventDefault();
      const item = getSortedMeters().find((meter) => meter.id === event.target.dataset.meterId);
      if (item) openMeterDetail(item);
    }
  });

  meterDetailClose.addEventListener('click', closeMeterDetail);
  meterDetailMask.addEventListener('click', (event) => {
    if (event.target === meterDetailMask) closeMeterDetail();
  });
  meterDetailQueryTab.addEventListener('click', () => {
    state.activeDetailTab = 'query';
    if (state.activeMeterId) {
      const item = getSortedMeters().find((meter) => meter.id === state.activeMeterId);
      if (item) renderDetail(item);
    }
  });
  meterDetailNotifyTab.addEventListener('click', () => {
    state.activeDetailTab = 'notify';
    if (state.activeMeterId) {
      const item = getSortedMeters().find((meter) => meter.id === state.activeMeterId);
      if (item) renderDetail(item);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!meterDetailMask.hidden && event.key === 'Escape') closeMeterDetail();
  });

  void boot();
}());
