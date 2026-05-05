const tauriStatusEl = document.getElementById('tauri-status');
const urlInput = document.getElementById('url-input');
const addBtn = document.getElementById('add-btn');
const addError = document.getElementById('add-error');
const siteListEl = document.getElementById('site-list');
const syncAllBtn = document.getElementById('sync-all');
const logEl = document.getElementById('log');

// 检测 Tauri 在线状态
async function checkTauri() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch('http://127.0.0.1:8765/health', { signal: ctrl.signal });
    if (res.ok) {
      tauriStatusEl.textContent = 'Tauri: ✓ 在线 (8765)';
      tauriStatusEl.className = 'tauri-status online';
    } else {
      throw new Error('not ok');
    }
  } catch {
    tauriStatusEl.textContent = 'Tauri: ✗ 离线';
    tauriStatusEl.className = 'tauri-status offline';
  }
}

function renderSites(data) {
  siteListEl.innerHTML = '';
  if (!data.sites || data.sites.length === 0) {
    siteListEl.innerHTML = '<div class="site-item"><span style="color:#888;font-size:11px;">暂无站点，请添加</span></div>';
    return;
  }

  for (const s of data.sites) {
    const item = document.createElement('div');
    item.className = 'site-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.title = s.enabled ? '已启用' : '已禁用';
    cb.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ type: 'setEnabled', hostname: s.hostname, enabled: cb.checked });
      refresh();
    });

    const info = document.createElement('div');
    info.className = 'site-info';
    const host = document.createElement('div');
    host.className = 'site-hostname';
    host.textContent = s.hostname;
    const meta = document.createElement('div');
    meta.className = 'site-meta';
    if (s.lastSyncTs) {
      const ago = Math.floor((Date.now() - s.lastSyncTs) / 1000);
      meta.textContent = ago < 60 ? '最近同步 ' + ago + ' 秒前' : '最近同步 ' + Math.floor(ago / 60) + ' 分钟前';
    } else {
      meta.textContent = '未同步';
    }
    info.appendChild(host);
    info.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '🗑';
    del.title = '删除';
    del.addEventListener('click', async () => {
      if (!confirm(`删除 ${s.hostname}？`)) return;
      await chrome.runtime.sendMessage({ type: 'removeSite', hostname: s.hostname });
      refresh();
    });

    item.appendChild(cb);
    item.appendChild(info);
    item.appendChild(del);
    siteListEl.appendChild(item);
  }
}

function renderLog(data) {
  logEl.innerHTML = '';
  if (!data.log || data.log.length === 0) {
    logEl.textContent = '暂无日志';
    return;
  }
  for (const e of data.log) {
    const div = document.createElement('div');
    div.className = e.status === 'OK' ? 'ok' : 'err';
    div.textContent = `${e.time} [${e.status}] ${e.domain}${e.detail ? ' ' + e.detail : ''}`;
    logEl.appendChild(div);
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
  renderSites(status);
  renderLog(status);
}

// 添加站点
async function doAdd() {
  addError.textContent = '';
  const url = urlInput.value.trim();
  if (!url) return;
  const result = await chrome.runtime.sendMessage({ type: 'addSite', url });
  if (result.ok) {
    urlInput.value = '';
    refresh();
  } else {
    addError.textContent = result.error;
  }
}

addBtn.addEventListener('click', doAdd);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doAdd();
});

// 同步全部
syncAllBtn.addEventListener('click', async () => {
  syncAllBtn.textContent = '同步中...';
  syncAllBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'syncNow' });
  await refresh();
  syncAllBtn.textContent = '立即同步全部';
  syncAllBtn.disabled = false;
});

// 初始化
checkTauri();
refresh();

// 默认填入当前标签页 URL，方便直接添加当前站点
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]?.url) {
    urlInput.value = tabs[0].url;
  }
});
