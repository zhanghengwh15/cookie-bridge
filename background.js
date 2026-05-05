// ========== 配置层 ==========
const STORAGE_KEY = 'sites';

async function getSites() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data.sites || []).filter(s => s.enabled);
}

async function getAllSites() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data.sites || [];
}

async function addSite(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { ok: false, error: 'URL 格式错误' };
  }
  if (!hostname) return { ok: false, error: '无法解析 hostname' };

  const sites = await getAllSites();
  if (sites.some(s => s.hostname === hostname)) {
    return { ok: false, error: '该域名已存在' };
  }
  sites.push({ url, hostname, enabled: true, addedAt: Date.now() });
  await chrome.storage.local.set({ sites });
  return { ok: true };
}

async function removeSite(hostname) {
  const sites = await getAllSites();
  const next = sites.filter(s => s.hostname !== hostname);
  await chrome.storage.local.set({ sites: next });
}

async function setEnabled(hostname, enabled) {
  const sites = await getAllSites();
  const idx = sites.findIndex(s => s.hostname === hostname);
  if (idx >= 0) {
    sites[idx].enabled = enabled;
    await chrome.storage.local.set({ sites });
  }
}

// ========== 状态 ==========
const lsCache = new Map();       // hostname -> Map<key, value>
const debounceTimers = new Map(); // hostname -> timerId
const syncLog = [];              // 最近同步事件，最多 50 条
const MAX_LOG = 50;
const TAURI_ENDPOINT = 'http://127.0.0.1:8765/push';
const LS_CACHE_KEY = 'lsCache_v1'; // 持久化 key，解决 MV3 Service Worker 休眠丢失问题

// 从 storage 恢复 lsCache（MV3 Service Worker 休眠后会丢失内存数据）
async function loadLsCache() {
  try {
    const data = await chrome.storage.local.get(LS_CACHE_KEY);
    const stored = data[LS_CACHE_KEY];
    if (stored) {
      lsCache.clear();
      for (const [host, entries] of Object.entries(stored)) {
        lsCache.set(host, new Map(Object.entries(entries)));
      }
      console.log('[CookieBridge] lsCache 已从 storage 恢复，hosts=', Array.from(lsCache.keys()));
    } else {
      console.log('[CookieBridge] lsCache storage 为空，无需恢复');
    }
  } catch (e) {
    console.warn('[CookieBridge] lsCache 恢复失败', e);
  }
}

// 保存 lsCache 到 storage
async function saveLsCache() {
  try {
    const obj = {};
    for (const [host, map] of lsCache) {
      obj[host] = Object.fromEntries(map);
    }
    await chrome.storage.local.set({ [LS_CACHE_KEY]: obj });
  } catch (e) {
    console.warn('[CookieBridge] lsCache 保存失败', e);
  }
}

// ========== content script 注册 ==========
async function registerScripts() {
  const sites = await getSites();
  const matches = sites.map(s => `*://${s.hostname}/*`);

  // 先全部注销
  try {
    await chrome.scripting.unregisterContentScripts();
  } catch { /* ignore */ }

  if (matches.length === 0) return;

  const scripts = [];
  // MAIN world hook
  scripts.push({
    id: 'cs-main',
    matches,
    js: ['inject.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
  });
  // ISOLATED world bridge
  scripts.push({
    id: 'cs-iso',
    matches,
    js: ['content.js'],
    runAt: 'document_start',
    world: 'ISOLATED',
    allFrames: false,
  });

  await chrome.scripting.registerContentScripts(scripts);
}

// ========== 同步核心 ==========
function shapeCookie(c) {
  return {
    domain: c.domain,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    expires: c.expirationDate ? Math.floor(c.expirationDate) : 0,
    secure: c.secure ? 1 : 0,
    httpOnly: c.httpOnly ? 1 : 0,
    sameSite: c.sameSite || 'unspecified',
  };
}

async function pushToTauri(payload) {
  try {
    const body = JSON.stringify(payload);
    console.log('[CookieBridge] 请求体', payload.domain, body.substring(0, 2000));
    const res = await fetch(TAURI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    console.log('[CookieBridge] 推送成功', payload.domain, json);
    setBadge('OK', '#16a34a');
    logEvent('OK', payload.domain);
    return true;
  } catch (e) {
    console.error('[CookieBridge] 推送失败', e);
    setBadge('ERR', '#dc2626');
    logEvent('ERR', payload.domain, e.message);
    return false;
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
}

function logEvent(status, domain, detail = '') {
  syncLog.unshift({
    time: new Date().toLocaleTimeString(),
    status,
    domain,
    detail,
    ts: Date.now(),
  });
  if (syncLog.length > MAX_LOG) syncLog.pop();
}

async function fetchCookiesForHost(hostname) {
  // 先按 domain 过滤（对普通域名有效）
  let cookies = await chrome.cookies.getAll({ domain: hostname });

  // 对 IP 地址或 host-only cookie，domain 过滤可能失效，再用 url 兜底
  if (cookies.length === 0) {
    const urls = [
      `http://${hostname}/`,
      `https://${hostname}/`,
    ];
    for (const url of urls) {
      try {
        const byUrl = await chrome.cookies.getAll({ url });
        for (const c of byUrl) {
          if (!cookies.some(x => x.name === c.name && x.domain === c.domain)) {
            cookies.push(c);
          }
        }
      } catch { /* ignore invalid url */ }
    }
  }

  return cookies;
}

function syncDomain(hostname) {
  clearTimeout(debounceTimers.get(hostname));
  const t = setTimeout(async () => {
    debounceTimers.delete(hostname);
    try {
      const cookies = await fetchCookiesForHost(hostname);
      const lsMap = lsCache.get(hostname);
      const localStorage = lsMap ? Object.fromEntries(lsMap) : null;

      console.log('[CookieBridge DEBUG] syncDomain', hostname,
        '| cookies=', cookies.length,
        '| ls keys=', lsMap ? lsMap.size : 0,
        '| lsCache hosts=', Array.from(lsCache.keys()));

      await pushToTauri({
        domain: hostname,
        cookies: cookies.map(shapeCookie),
        localStorage,
        ts: Date.now(),
      });
    } catch (e) {
      console.warn('[CookieBridge] syncDomain 失败', hostname, e);
    }
  }, 200);
  debounceTimers.set(hostname, t);
}

async function syncAll() {
  const sites = await getSites();
  for (const s of sites) {
    syncDomain(s.hostname);
  }
}

// ========== 触发源 ==========

// 1. 启动 / 安装
chrome.runtime.onStartup.addListener(() => {
  loadLsCache().then(() => registerScripts().then(syncAll));
});
chrome.runtime.onInstalled.addListener(() => {
  loadLsCache().then(() => registerScripts().then(syncAll));
});

// 2. 配置变化 -> 重新注册
chrome.storage.onChanged.addListener((changes) => {
  if (changes.sites) {
    registerScripts().then(syncAll);
  }
});

// 3. 定时同步
chrome.alarms.create('sync', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') syncAll();
});

// 4. cookie 变化
chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  const cookieDomain = cookie.domain.replace(/^\./, '');
  const sites = await getSites();
  const matched = sites.filter(
    s => s.hostname === cookieDomain || s.hostname.endsWith('.' + cookieDomain)
  );
  for (const s of matched) {
    syncDomain(s.hostname);
  }
});

// 5. popup 消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'syncNow': {
        if (msg.hostname) {
          syncDomain(msg.hostname);
        } else {
          const sites = await getSites();
          for (const s of sites) {
            const tabs = await chrome.tabs.query({ url: `*://${s.hostname}/*` });
            if (tabs.length > 0) {
              try {
                const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'requestFullLs' });
                if (res && res.all) {
                  lsCache.set(s.hostname, new Map(Object.entries(res.all)));
                  await saveLsCache();
                }
              } catch (e) {
                console.warn('[CookieBridge] 请求全量 ls 失败', s.hostname, e);
              }
            }
            syncDomain(s.hostname);
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case 'addSite': {
        const result = await addSite(msg.url);
        sendResponse(result);
        break;
      }
      case 'removeSite': {
        // 清理关联状态
        lsCache.delete(msg.hostname);
        clearTimeout(debounceTimers.get(msg.hostname));
        debounceTimers.delete(msg.hostname);
        await removeSite(msg.hostname);
        sendResponse({ ok: true });
        break;
      }
      case 'setEnabled': {
        await setEnabled(msg.hostname, msg.enabled);
        sendResponse({ ok: true });
        break;
      }
      case 'getStatus': {
        const sites = await getAllSites();
        // 计算每个 site 的最近同步时间
        const siteStatus = sites.map(s => {
          const last = syncLog.find(l => l.domain === s.hostname);
          return { ...s, lastSyncTs: last ? last.ts : 0 };
        });
        sendResponse({ sites: siteStatus, log: syncLog.slice(0, 20) });
        break;
      }
      case 'lsUpdate': {
        const host = msg.hostname;
        console.log('[CookieBridge DEBUG] 收到 lsUpdate', host, 'op=', msg.op, 'sender=', sender.url || sender.tab?.url);
        let map = lsCache.get(host);
        if (!map) {
          map = new Map();
          lsCache.set(host, map);
        }
        switch (msg.op) {
          case 'set':
            map.set(msg.k, msg.v);
            break;
          case 'remove':
            map.delete(msg.k);
            break;
          case 'clear':
            map.clear();
            break;
          case 'full':
            const entries = msg.all || {};
            console.log('[CookieBridge DEBUG] lsUpdate full', host, 'entries=', Object.keys(entries).length);
            lsCache.set(host, new Map(Object.entries(entries)));
            break;
        }
        await saveLsCache();
        syncDomain(host);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: '未知消息类型' });
    }
  })();
  return true; // 异步 sendResponse
});
